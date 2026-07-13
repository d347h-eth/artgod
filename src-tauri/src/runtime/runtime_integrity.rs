use std::path::Path;

#[cfg(any(not(debug_assertions), test))]
use sha2::{Digest, Sha256};
#[cfg(any(not(debug_assertions), test))]
use std::collections::HashSet;
#[cfg(any(not(debug_assertions), test))]
use std::fs::{self, File};
#[cfg(any(not(debug_assertions), test))]
use std::io::{BufReader, Read};
#[cfg(any(not(debug_assertions), test))]
use std::path::{Component, PathBuf};

#[cfg(not(debug_assertions))]
use super::resource_contract::WALLET_RECIPIENT_PROTECTED_ROOTS;

#[cfg(any(not(debug_assertions), test))]
#[derive(Clone, Copy)]
struct PinnedRuntimeFile<'a> {
    relative_path: &'a str,
    sha256: &'a str,
}

// Bounds each missing/unexpected category in local integrity diagnostics.
#[cfg(any(not(debug_assertions), test))]
const FILE_SET_DIAGNOSTIC_PATH_LIMIT: usize = 8;
// Bounds one rendered relative path so a hostile filename cannot flood local logs.
#[cfg(any(not(debug_assertions), test))]
const FILE_SET_DIAGNOSTIC_PATH_CHAR_LIMIT: usize = 240;

// `include!` requires a literal path; the contract test keeps this name synchronized.
#[cfg(any(not(debug_assertions), test))]
include!(concat!(env!("OUT_DIR"), "/wallet_recipient_integrity.rs"));

/// Verifies release-bundled code and dependencies before the unlock prompt opens.
pub(crate) fn verify_wallet_recipient_runtime(
    runtime_dir: &Path,
    required_paths: &[&Path],
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let _ = (runtime_dir, required_paths);
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        verify_pinned_runtime_files(
            runtime_dir,
            WALLET_RECIPIENT_PROTECTED_ROOTS,
            EMBEDDED_WALLET_RECIPIENT_RUNTIME_FILES,
            required_paths,
        )
    }
}

#[cfg(any(not(debug_assertions), test))]
fn verify_pinned_runtime_files(
    runtime_dir: &Path,
    protected_roots: &[&str],
    pinned_files: &[PinnedRuntimeFile<'_>],
    required_paths: &[&Path],
) -> Result<(), String> {
    if pinned_files.is_empty() {
        return Err("Wallet recipient runtime integrity manifest is empty.".to_owned());
    }
    let runtime_dir = canonicalize_directory(runtime_dir, "Bundled runtime resources")?;
    let actual_files = collect_protected_files(&runtime_dir, protected_roots)?;
    let actual_relative_files = relative_file_set(&runtime_dir, &actual_files)?;
    let mut expected_relative_files = HashSet::<PathBuf>::with_capacity(pinned_files.len());

    for pinned in pinned_files {
        let relative_path = validate_relative_path(pinned.relative_path)?;
        if !expected_relative_files.insert(relative_path.to_path_buf()) {
            return Err(format!(
                "Wallet recipient runtime integrity manifest contains a duplicate path: {}",
                pinned.relative_path
            ));
        }
    }

    if actual_relative_files != expected_relative_files {
        return Err(format_file_set_difference(
            &expected_relative_files,
            &actual_relative_files,
        ));
    }

    let mut expected_files = HashSet::<PathBuf>::with_capacity(pinned_files.len());
    let mut files_to_hash = Vec::<(PathBuf, &str)>::with_capacity(pinned_files.len());
    for pinned in pinned_files {
        let candidate = runtime_dir.join(validate_relative_path(pinned.relative_path)?);
        let canonical = canonicalize_regular_file(&candidate, "Pinned runtime file")?;
        if !canonical.starts_with(&runtime_dir) {
            return Err(format!(
                "Pinned runtime file escapes bundled resources: {}",
                canonical.display()
            ));
        }
        expected_files.insert(canonical.clone());
        files_to_hash.push((canonical, pinned.sha256));
    }

    // Reject path replacement or aliasing between file-set collection and canonicalization.
    ensure_canonical_file_set_unchanged(&actual_files, &expected_files)?;

    for (path, expected_sha256) in files_to_hash {
        let actual_sha256 = sha256_file(&path)?;
        if actual_sha256 != expected_sha256 {
            return Err(format!(
                "Wallet recipient runtime integrity mismatch: {}",
                path.display()
            ));
        }
    }

    for required_path in required_paths {
        let canonical = canonicalize_regular_file(required_path, "Required bot runtime file")?;
        if !canonical.starts_with(&runtime_dir) || !expected_files.contains(&canonical) {
            return Err(format!(
                "Required bot runtime file is not integrity-pinned: {}",
                canonical.display()
            ));
        }
    }

    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn ensure_canonical_file_set_unchanged(
    collected_files: &HashSet<PathBuf>,
    canonicalized_expected_files: &HashSet<PathBuf>,
) -> Result<(), String> {
    if collected_files != canonicalized_expected_files {
        return Err(
            "Wallet recipient runtime files changed during integrity validation.".to_owned(),
        );
    }
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn relative_file_set(
    runtime_dir: &Path,
    files: &HashSet<PathBuf>,
) -> Result<HashSet<PathBuf>, String> {
    files
        .iter()
        .map(|path| {
            path.strip_prefix(runtime_dir)
                .map(Path::to_path_buf)
                .map_err(|_| {
                    format!(
                        "Wallet recipient runtime file escapes bundled resources: {}",
                        path.display()
                    )
                })
        })
        .collect()
}

#[cfg(any(not(debug_assertions), test))]
fn format_file_set_difference(
    expected_files: &HashSet<PathBuf>,
    actual_files: &HashSet<PathBuf>,
) -> String {
    let missing = expected_files.difference(actual_files).collect::<Vec<_>>();
    let unexpected = actual_files.difference(expected_files).collect::<Vec<_>>();
    format!(
        "Wallet recipient runtime file set differs from the embedded release manifest. Missing files ({}): {}; unexpected files ({}): {}.",
        missing.len(),
        format_diagnostic_paths(missing),
        unexpected.len(),
        format_diagnostic_paths(unexpected),
    )
}

#[cfg(any(not(debug_assertions), test))]
fn format_diagnostic_paths(mut paths: Vec<&PathBuf>) -> String {
    paths.sort();
    let omitted = paths.len().saturating_sub(FILE_SET_DIAGNOSTIC_PATH_LIMIT);
    paths.truncate(FILE_SET_DIAGNOSTIC_PATH_LIMIT);
    let mut rendered = paths
        .into_iter()
        .map(|path| format!("{:?}", bounded_relative_path(path)))
        .collect::<Vec<_>>();
    if omitted > 0 {
        rendered.push(format!("(+{omitted} more)"));
    }
    format!("[{}]", rendered.join(", "))
}

#[cfg(any(not(debug_assertions), test))]
fn bounded_relative_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    let mut characters = value.chars();
    let mut bounded = characters
        .by_ref()
        .take(FILE_SET_DIAGNOSTIC_PATH_CHAR_LIMIT)
        .collect::<String>();
    if characters.next().is_some() {
        bounded.push_str("...");
    }
    bounded
}

#[cfg(any(not(debug_assertions), test))]
fn collect_protected_files(
    runtime_dir: &Path,
    protected_roots: &[&str],
) -> Result<HashSet<PathBuf>, String> {
    let mut files = HashSet::<PathBuf>::new();
    for protected_root in protected_roots {
        let relative_path = validate_relative_path(protected_root)?;
        collect_regular_files(&runtime_dir.join(relative_path), runtime_dir, &mut files)?;
    }
    Ok(files)
}

#[cfg(any(not(debug_assertions), test))]
fn collect_regular_files(
    path: &Path,
    runtime_dir: &Path,
    files: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Wallet recipient runtime path is unavailable at {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Wallet recipient runtime path must not be a symbolic link: {}",
            path.display()
        ));
    }
    if metadata.is_file() {
        let canonical = fs::canonicalize(path).map_err(|error| {
            format!(
                "Failed to canonicalize wallet recipient runtime file {}: {error}",
                path.display()
            )
        })?;
        if !canonical.starts_with(runtime_dir) {
            return Err(format!(
                "Wallet recipient runtime file escapes bundled resources: {}",
                canonical.display()
            ));
        }
        files.insert(canonical);
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "Wallet recipient runtime path is not a file or directory: {}",
            path.display()
        ));
    }

    let mut entries = fs::read_dir(path)
        .map_err(|error| {
            format!(
                "Failed to read runtime directory {}: {error}",
                path.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read runtime directory entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        collect_regular_files(&entry.path(), runtime_dir, files)?;
    }
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn validate_relative_path(raw_path: &str) -> Result<&Path, String> {
    let path = Path::new(raw_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "Runtime integrity path is not a normalized relative path: {raw_path}"
        ));
    }
    Ok(path)
}

#[cfg(any(not(debug_assertions), test))]
fn canonicalize_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} is unavailable at {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{label} must be a real directory: {}",
            path.display()
        ));
    }
    fs::canonicalize(path)
        .map_err(|error| format!("Failed to canonicalize {label} {}: {error}", path.display()))
}

#[cfg(any(not(debug_assertions), test))]
fn canonicalize_regular_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} is unavailable at {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a real file: {}", path.display()));
    }
    fs::canonicalize(path)
        .map_err(|error| format!("Failed to canonicalize {label} {}: {error}", path.display()))
}

#[cfg(any(not(debug_assertions), test))]
fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path)
        .map_err(|error| format!("Failed to open runtime file {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash runtime file {}: {error}", path.display()))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::resource_contract::GENERATED_WALLET_RECIPIENT_INTEGRITY_FILE_NAME;
    #[cfg(not(debug_assertions))]
    use crate::runtime::{
        bot_runtime::BIDDING_BOT_SPEC,
        resource_contract::{
            BUNDLED_RUNTIME_RELATIVE_PATH, NODE_BINARY_RELATIVE_PATH, PNP_CJS_RELATIVE_PATH,
            PNP_LOADER_RELATIVE_PATH,
        },
    };

    fn write_file(root: &Path, relative_path: &str, contents: &[u8]) -> PathBuf {
        let path = root.join(relative_path);
        fs::create_dir_all(path.parent().expect("test file parent")).expect("create test parent");
        fs::write(&path, contents).expect("write test file");
        path
    }

    #[test]
    fn generated_manifest_include_name_matches_resource_contract() {
        assert_eq!(
            GENERATED_WALLET_RECIPIENT_INTEGRITY_FILE_NAME,
            "wallet_recipient_integrity.rs"
        );
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn embedded_release_manifest_matches_staged_wallet_recipient() {
        let runtime_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(BUNDLED_RUNTIME_RELATIVE_PATH);
        let required_paths = [
            runtime_dir.join(NODE_BINARY_RELATIVE_PATH),
            runtime_dir.join(PNP_CJS_RELATIVE_PATH),
            runtime_dir.join(PNP_LOADER_RELATIVE_PATH),
            runtime_dir.join(BIDDING_BOT_SPEC.artifact_relative_path),
        ];
        let required_paths = required_paths
            .iter()
            .map(PathBuf::as_path)
            .collect::<Vec<_>>();

        verify_wallet_recipient_runtime(&runtime_dir, &required_paths)
            .expect("staged release recipient must match embedded hashes");
    }

    #[test]
    fn sha256_uses_the_standard_digest() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = write_file(temp.path(), "digest-input", b"abc");

        assert_eq!(
            sha256_file(&path).expect("hash should succeed"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn exact_pinned_runtime_file_set_passes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact = write_file(temp.path(), "code/bot.mjs", b"trusted bot");
        let hash = sha256_file(&artifact).expect("hash");
        let pinned = [PinnedRuntimeFile {
            relative_path: "code/bot.mjs",
            sha256: &hash,
        }];

        verify_pinned_runtime_files(temp.path(), &["code"], &pinned, &[&artifact])
            .expect("exact manifest should pass");
    }

    #[test]
    fn modified_runtime_file_fails_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact = write_file(temp.path(), "code/bot.mjs", b"trusted bot");
        let hash = sha256_file(&artifact).expect("hash");
        let pinned = [PinnedRuntimeFile {
            relative_path: "code/bot.mjs",
            sha256: &hash,
        }];
        fs::write(&artifact, b"redirected bot").expect("tamper test artifact");

        let error = verify_pinned_runtime_files(temp.path(), &["code"], &pinned, &[&artifact])
            .expect_err("modified file must fail");

        assert!(error.contains("integrity mismatch"));
    }

    #[test]
    fn added_runtime_file_fails_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact = write_file(temp.path(), "code/bot.mjs", b"trusted bot");
        let hash = sha256_file(&artifact).expect("hash");
        let pinned = [PinnedRuntimeFile {
            relative_path: "code/bot.mjs",
            sha256: &hash,
        }];
        write_file(temp.path(), "code/injected.mjs", b"injected code");

        let error = verify_pinned_runtime_files(temp.path(), &["code"], &pinned, &[&artifact])
            .expect_err("added file must fail");

        assert!(error.contains("file set differs"));
        assert!(error.contains("Missing files (0): []"));
        assert!(error.contains("unexpected files (1): [\"code/injected.mjs\"]"));
        assert!(!error.contains(temp.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn missing_runtime_file_reports_a_relative_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join("code")).expect("create protected root");
        let pinned = [PinnedRuntimeFile {
            relative_path: "code/missing.mjs",
            sha256: "unused",
        }];

        let error = verify_pinned_runtime_files(temp.path(), &["code"], &pinned, &[])
            .expect_err("missing file must fail");

        assert!(error.contains("Missing files (1): [\"code/missing.mjs\"]"));
        assert!(error.contains("unexpected files (0): []"));
        assert!(!error.contains(temp.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn file_set_diagnostics_are_sorted_and_bounded() {
        let omitted_count = 2;
        let expected_count = FILE_SET_DIAGNOSTIC_PATH_LIMIT + omitted_count;
        let expected = (0..expected_count)
            .map(|index| PathBuf::from(format!("code/missing-{index:02}.mjs")))
            .collect::<HashSet<_>>();
        let actual = ["code/unexpected-b.mjs", "code/unexpected-a.mjs"]
            .into_iter()
            .map(PathBuf::from)
            .collect::<HashSet<_>>();

        let error = format_file_set_difference(&expected, &actual);

        assert!(error.contains(&format!("Missing files ({expected_count}):")));
        assert!(error.contains("\"code/missing-00.mjs\", \"code/missing-01.mjs\""));
        assert!(!error.contains("code/missing-08.mjs"));
        assert!(error.contains(&format!("(+{omitted_count} more)")));
        assert!(error.contains(
            "unexpected files (2): [\"code/unexpected-a.mjs\", \"code/unexpected-b.mjs\"]"
        ));
    }

    #[test]
    fn file_set_diagnostics_bound_individual_path_length() {
        let long_name = format!(
            "code/{}.mjs",
            "x".repeat(FILE_SET_DIAGNOSTIC_PATH_CHAR_LIMIT + 20)
        );
        let expected = HashSet::from([PathBuf::from(long_name)]);

        let error = format_file_set_difference(&expected, &HashSet::new());

        assert!(error.contains("...\""));
        assert!(error.len() < FILE_SET_DIAGNOSTIC_PATH_CHAR_LIMIT + 200);
    }

    #[test]
    fn canonical_file_set_change_during_validation_fails_closed() {
        let collected = HashSet::from([PathBuf::from("runtime/first.mjs")]);
        let canonicalized = HashSet::from([PathBuf::from("runtime/second.mjs")]);

        let error = ensure_canonical_file_set_unchanged(&collected, &canonicalized)
            .expect_err("changed canonical set must fail");

        assert!(error.contains("changed during integrity validation"));
    }

    #[test]
    fn required_recipient_file_must_be_in_manifest() {
        let temp = tempfile::tempdir().expect("tempdir");
        let hook = write_file(temp.path(), "hook.cjs", b"trusted hook");
        let artifact = write_file(temp.path(), "bot.mjs", b"unlisted bot");
        let hash = sha256_file(&hook).expect("hash");
        let pinned = [PinnedRuntimeFile {
            relative_path: "hook.cjs",
            sha256: &hash,
        }];

        let error =
            verify_pinned_runtime_files(temp.path(), &["hook.cjs"], &pinned, &[&hook, &artifact])
                .expect_err("unlisted recipient must fail");

        assert!(error.contains("not integrity-pinned"));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_in_protected_runtime_fails_closed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let outside = write_file(temp.path(), "outside.mjs", b"outside code");
        fs::create_dir_all(temp.path().join("code")).expect("create protected root");
        symlink(&outside, temp.path().join("code/bot.mjs")).expect("create symlink");
        let pinned = [PinnedRuntimeFile {
            relative_path: "code/bot.mjs",
            sha256: "unused",
        }];

        let error = verify_pinned_runtime_files(temp.path(), &["code"], &pinned, &[])
            .expect_err("symlink must fail");

        assert!(error.contains("symbolic link"));
    }
}
