//! Preservation-only preparation for the bundled NATS filestore. NATS applies
//! saved MaxAge during restore, before its administration API is available.
//! Never read or rewrite message blocks or consumer state here.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use highway::{HighwayHash, HighwayHasher, Key};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(crate) const PREPARE_STORE_ARG: &str = "--prepare-nats-job-store";
pub(crate) const PREPARE_STORE_PROCESS_NAME: &str = "nats-store-preparation";
const META_FILE: &str = "meta.inf";
const SUM_FILE: &str = "meta.sum";
const KEY_FILE: &str = "meta.key";
const JOURNAL_FILE: &str = ".artgod-age-policy-v1.json";
const RUNTIME_LOCK_FILE: &str = ".artgod-runtime.lock";
const PREPARATION_LOCK_FILE: &str = ".artgod-preparation.lock";
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_JOURNAL_BYTES: u64 = MAX_METADATA_BYTES * 8;
const JOURNAL_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobsPolicy {
    max_age_nanos: u64,
    stream_name_suffix: String,
    subject_token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MigrationJournal {
    version: u32,
    before: String,
    after: String,
    before_sum: String,
    after_sum: String,
}

/// Held by the supervisor for its whole lifetime, including cleanup and backoff.
pub(crate) fn acquire_runtime_store_lock(store: &Path) -> Result<File, String> {
    acquire_lock(&store.join(RUNTIME_LOCK_FILE))
}

fn acquire_lock(path: &Path) -> Result<File, String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("NATS store lock must be a regular file".to_owned());
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("Cannot open NATS store lock: {e}"))?;
    file.try_lock()
        .map_err(|e| format!("NATS store is already in use: {e}"))?;
    Ok(file)
}

/// A private child mode, handled before Tauri initialization. Inputs are explicit
/// paths/identity only; this process never loads a wallet or starts services.
pub fn run_preparation_child() -> Option<Result<(), String>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(PREPARE_STORE_ARG)) {
        return None;
    }
    Some((|| {
        let store = PathBuf::from(args.next().ok_or("Missing NATS store path")?);
        let prefix = args
            .next()
            .and_then(|s| s.into_string().ok())
            .ok_or("Missing NATS stream prefix")?;
        let address: SocketAddr = args
            .next()
            .and_then(|s| s.into_string().ok())
            .ok_or("Missing NATS listener address")?
            .parse()
            .map_err(|e| format!("Invalid NATS listener: {e}"))?;
        if args.next().is_some() || !address.ip().is_loopback() {
            return Err("Invalid NATS preparation arguments".to_owned());
        }
        // The runtime lease excludes another current app instance. This separate
        // lock also excludes simultaneous helper invocations. A live legacy NATS
        // listener is rejected; this operation is never an online repair.
        let _lock = acquire_lock(&store.join(PREPARATION_LOCK_FILE))?;
        match TcpStream::connect_timeout(&address, Duration::from_millis(300)) {
            Ok(_) => {
                return Err("NATS is already listening; stop it before retrying startup".to_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {}
            Err(e) => return Err(format!("Cannot establish that NATS is stopped: {e}")),
        }
        let changed = prepare_jobs_store(&store, &prefix, |_| Ok(()))?;
        println!("NATS store preservation check completed (age policy migrated: {changed})");
        Ok(())
    })())
}

fn prepare_jobs_store(
    store: &Path,
    prefix: &str,
    mut after_write: impl FnMut(u8) -> Result<(), String>,
) -> Result<bool, String> {
    if prefix.is_empty()
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid NATS stream prefix for store preparation".to_owned());
    }
    let policy: JobsPolicy = serde_json::from_str(include_str!(
        "../../../shared/queue/nats-job-stream-policy.json"
    ))
    .map_err(|e| format!("Invalid bundled jobs policy: {e}"))?;
    if policy.max_age_nanos != 0 {
        return Err("NATS startup preparation only supports disabling age expiry".to_owned());
    }
    let name = format!("{prefix}-{}", policy.stream_name_suffix);
    let subject = format!("{prefix}.{}.>", policy.subject_token);
    let mut dir = store.to_path_buf();
    // This is the desktop's unauthenticated, single-account store layout. Refuse
    // symlinks and unexpected metadata instead of guessing another store format.
    for part in ["", "jetstream", "$G", "streams", name.as_str()] {
        if !part.is_empty() {
            dir.push(part);
        }
        match fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("Cannot inspect NATS store: {e}")),
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => return Err("Unsupported NATS store directory".to_owned()),
        }
    }
    if dir.join(KEY_FILE).try_exists().map_err(|e| e.to_string())? {
        return Err("Encrypted NATS metadata cannot be migrated by this startup task".to_owned());
    }
    let meta_path = dir.join(META_FILE);
    let sum_path = dir.join(SUM_FILE);
    let journal_path = dir.join(JOURNAL_FILE);
    let before = read_regular(&meta_path, MAX_METADATA_BYTES)?;
    let before_sum = read_regular(&sum_path, MAX_METADATA_BYTES)?;

    let journal = if journal_path.try_exists().map_err(|e| e.to_string())? {
        let journal: MigrationJournal =
            serde_json::from_str(&read_regular(&journal_path, MAX_JOURNAL_BYTES)?)
                .map_err(|e| format!("Invalid NATS migration journal: {e}"))?;
        if journal.version != JOURNAL_VERSION
            || checksum(&name, journal.before.as_bytes()) != journal.before_sum
            || checksum(&name, journal.after.as_bytes()) != journal.after_sum
            || (before != journal.before && before != journal.after)
            || (before_sum != journal.before_sum && before_sum != journal.after_sum)
        {
            return Err(
                "NATS metadata changed outside the interrupted migration; refusing startup"
                    .to_owned(),
            );
        }
        let expected = migrated_metadata(&journal.before, &name, &subject)?
            .ok_or("NATS migration journal has no age policy change")?;
        if expected != journal.after {
            return Err("NATS migration journal changes more than the age policy".to_owned());
        }
        journal
    } else {
        if checksum(&name, before.as_bytes()) != before_sum {
            return Err("NATS stream metadata checksum mismatch; refusing startup".to_owned());
        }
        let Some(after) = migrated_metadata(&before, &name, &subject)? else {
            return Ok(false);
        };
        let journal = MigrationJournal {
            version: JOURNAL_VERSION,
            after_sum: checksum(&name, after.as_bytes()),
            before,
            before_sum,
            after,
        };
        write_atomic(
            &journal_path,
            &serde_json::to_vec(&journal).map_err(|e| e.to_string())?,
        )?;
        after_write(0)?;
        journal
    };

    // Each rename is atomic and journaled. On cancellation or hard termination,
    // retry accepts only the original/new pair and finishes before NATS starts.
    write_atomic(&meta_path, journal.after.as_bytes())?;
    after_write(1)?;
    write_atomic(&sum_path, journal.after_sum.as_bytes())?;
    after_write(2)?;
    fs::remove_file(&journal_path).map_err(|e| format!("Cannot finish NATS migration: {e}"))?;
    sync_directory(&dir)?;
    Ok(true)
}

fn migrated_metadata(before: &str, name: &str, subject: &str) -> Result<Option<String>, String> {
    let mut meta: Value =
        serde_json::from_str(before).map_err(|e| format!("Invalid NATS stream metadata: {e}"))?;
    if meta["name"].as_str() != Some(name)
        || meta["retention"] != "workqueue"
        || meta["storage"] != "file"
        || meta["num_replicas"] != 1
        || meta["subjects"] != serde_json::json!([subject])
        || meta["Created"].as_str().is_none()
        || !meta["mirror"].is_null()
        || !meta["sources"].is_null()
    {
        return Err("Unsupported jobs stream metadata; refusing age policy migration".to_owned());
    }
    let age = meta
        .get("max_age")
        .map_or(Some(0), Value::as_u64)
        .ok_or("Invalid NATS stream age limit")?;
    if age == 0 {
        return Ok(None);
    }
    meta["max_age"] = Value::from(0);
    serde_json::to_string(&meta)
        .map(Some)
        .map_err(|e| e.to_string())
}

fn read_regular(path: &Path, max_bytes: u64) -> Result<String, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Cannot read NATS metadata: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return Err("NATS metadata must be a bounded regular file".to_owned());
    }
    let mut value = String::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(max_bytes + 1)
        .read_to_string(&mut value)
        .map_err(|e| e.to_string())?;
    if value.len() as u64 > max_bytes {
        return Err("NATS metadata exceeds size bound".to_owned());
    }
    Ok(value)
}

// NATS 2.10.18 uses HighwayHash64 with SHA256(stream name) as its key and
// hex-encoded little-endian output. This verifies integrity, not authenticity.
fn checksum(name: &str, bytes: &[u8]) -> String {
    let digest = Sha256::digest(name.as_bytes());
    let key = Key(std::array::from_fn(|i| {
        u64::from_le_bytes(digest[i * 8..i * 8 + 8].try_into().unwrap())
    }));
    HighwayHasher::new(key)
        .hash64(bytes)
        .to_le_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Missing NATS metadata parent")?;
    let temp = dir.join(format!(".artgod-metadata-{}", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temp, path).map_err(|e| format!("Cannot replace NATS metadata: {e}"))?;
    sync_directory(dir)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("Cannot sync NATS metadata directory: {e}"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PREFIX: &str = "review";
    const NAME: &str = "review-jobs";
    // Generated by NATS 2.10.18 in an empty, synthetic project-local store.
    const META: &str = include_str!("../../tests/fixtures/nats-store/meta.inf");
    const SUM: &str = include_str!("../../tests/fixtures/nats-store/meta.sum");

    fn fixture() -> (PathBuf, PathBuf) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp/nats-store-native-tests");
        fs::create_dir_all(&root).unwrap();
        let store = tempfile::Builder::new()
            .prefix("store-")
            .tempdir_in(root)
            .unwrap()
            .keep();
        let dir = store.join("jetstream/$G/streams").join(NAME);
        fs::create_dir_all(dir.join("msgs")).unwrap();
        fs::create_dir_all(dir.join("obs/consumer")).unwrap();
        fs::write(dir.join(META_FILE), META).unwrap();
        fs::write(dir.join(SUM_FILE), SUM).unwrap();
        fs::write(
            dir.join("msgs/synthetic.blk"),
            b"message bytes must be preserved",
        )
        .unwrap();
        fs::write(
            dir.join("obs/consumer/o.dat"),
            b"consumer bytes must be preserved",
        )
        .unwrap();
        (store, dir)
    }

    fn assert_migrated(dir: &Path) {
        let meta = read_regular(&dir.join(META_FILE), MAX_METADATA_BYTES).unwrap();
        let mut before: Value = serde_json::from_str(META).unwrap();
        before["max_age"] = Value::from(0);
        assert_eq!(serde_json::from_str::<Value>(&meta).unwrap(), before);
        assert_eq!(
            read_regular(&dir.join(SUM_FILE), 100).unwrap(),
            checksum(NAME, meta.as_bytes())
        );
        assert_eq!(
            fs::read(dir.join("msgs/synthetic.blk")).unwrap(),
            b"message bytes must be preserved"
        );
        assert_eq!(
            fs::read(dir.join("obs/consumer/o.dat")).unwrap(),
            b"consumer bytes must be preserved"
        );
        assert!(!dir.join(JOURNAL_FILE).exists());
    }

    #[test]
    fn verifies_real_nats_checksum_and_changes_only_the_age_policy() {
        assert_eq!(checksum(NAME, META.as_bytes()), SUM);
        let (store, dir) = fixture();
        assert!(prepare_jobs_store(&store, PREFIX, |_| Ok(())).unwrap());
        assert_migrated(&dir);
        assert!(!prepare_jobs_store(&store, PREFIX, |_| Ok(())).unwrap());
        assert_migrated(&dir);
    }

    #[test]
    fn retry_finishes_each_interrupted_pair_update_without_touching_jobs() {
        for interrupted_phase in 0..=2 {
            let (store, dir) = fixture();
            let error = prepare_jobs_store(&store, PREFIX, |phase| {
                if phase == interrupted_phase {
                    Err("simulated process termination".to_owned())
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            assert!(error.contains("simulated"));
            assert!(dir.join(JOURNAL_FILE).exists());
            assert!(prepare_jobs_store(&store, PREFIX, |_| Ok(())).unwrap());
            assert_migrated(&dir);
        }
    }

    #[test]
    fn checksum_failure_and_external_changes_fail_closed() {
        let (store, dir) = fixture();
        fs::write(dir.join(SUM_FILE), "invalid checksum").unwrap();
        assert!(
            prepare_jobs_store(&store, PREFIX, |_| Ok(()))
                .unwrap_err()
                .contains("checksum")
        );
        assert_eq!(fs::read_to_string(dir.join(META_FILE)).unwrap(), META);

        let (store, dir) = fixture();
        prepare_jobs_store(&store, PREFIX, |_| Err("stop".to_owned())).unwrap_err();
        fs::write(dir.join(META_FILE), "external change").unwrap();
        assert!(
            prepare_jobs_store(&store, PREFIX, |_| Ok(()))
                .unwrap_err()
                .contains("outside")
        );
        assert_eq!(
            fs::read_to_string(dir.join(META_FILE)).unwrap(),
            "external change"
        );
    }

    #[test]
    fn refuses_encryption_missing_metadata_and_unsupported_streams() {
        let (store, dir) = fixture();
        fs::write(dir.join(KEY_FILE), "synthetic encryption key marker").unwrap();
        assert!(prepare_jobs_store(&store, PREFIX, |_| Ok(())).is_err());
        assert_eq!(fs::read_to_string(dir.join(META_FILE)).unwrap(), META);
        let (store, dir) = fixture();
        fs::remove_file(dir.join(META_FILE)).unwrap();
        assert!(prepare_jobs_store(&store, PREFIX, |_| Ok(())).is_err());
        for (field, value) in [
            ("retention", "limits"),
            ("name", "another-stream"),
            ("storage", "memory"),
        ] {
            let (store, dir) = fixture();
            let mut meta: Value = serde_json::from_str(META).unwrap();
            meta[field] = Value::from(value);
            let bytes = serde_json::to_vec(&meta).unwrap();
            fs::write(dir.join(META_FILE), &bytes).unwrap();
            fs::write(dir.join(SUM_FILE), checksum(NAME, &bytes)).unwrap();
            assert!(prepare_jobs_store(&store, PREFIX, |_| Ok(())).is_err());
            assert_eq!(fs::read(dir.join(META_FILE)).unwrap(), bytes);
        }
    }

    #[test]
    fn runtime_lease_excludes_a_second_instance_and_releases_for_retry() {
        let (store, _) = fixture();
        let lock = acquire_runtime_store_lock(&store).unwrap();
        assert!(acquire_runtime_store_lock(&store).is_err());
        drop(lock);
        assert!(acquire_runtime_store_lock(&store).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_metadata() {
        let (store, dir) = fixture();
        let external = store.join("unrelated");
        fs::write(&external, META).unwrap();
        fs::remove_file(dir.join(META_FILE)).unwrap();
        std::os::unix::fs::symlink(&external, dir.join(META_FILE)).unwrap();
        assert!(prepare_jobs_store(&store, PREFIX, |_| Ok(())).is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), META);
    }

    #[test]
    fn new_store_needs_no_migration_and_rejects_path_like_prefix() {
        let (store, _) = fixture();
        assert!(!prepare_jobs_store(&store, "fresh", |_| Ok(())).unwrap());
        assert!(prepare_jobs_store(&store, "../other", |_| Ok(())).is_err());
    }
}
