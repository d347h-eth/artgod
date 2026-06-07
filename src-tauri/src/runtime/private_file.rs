use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use uuid::Uuid;

/// Atomically replaces a private app-data file while preserving restrictive file permissions.
pub(crate) fn write_private_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("File path has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create directory {}: {error}", parent.display()))?;
    let temp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file"),
        Uuid::new_v4()
    ));
    write_private_file(&temp_path, bytes)?;
    replace_file(&temp_path, path)?;
    apply_private_file_permissions(path)?;
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to create file {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("Failed to write file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync file {}: {error}", path.display()))?;
    Ok(())
}

fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        if target_path.exists() {
            let backup_path = temp_path.with_extension("bak");
            fs::rename(target_path, &backup_path).map_err(|error| {
                format!(
                    "Failed to prepare file replacement {}: {error}",
                    target_path.display()
                )
            })?;
            match fs::rename(temp_path, target_path) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup_path);
                    Ok(())
                }
                Err(error) => {
                    let _ = fs::rename(&backup_path, target_path);
                    Err(format!(
                        "Failed to replace file {}: {error}",
                        target_path.display()
                    ))
                }
            }
        } else {
            fs::rename(temp_path, target_path).map_err(|error| {
                format!(
                    "Failed to move file into place {}: {error}",
                    target_path.display()
                )
            })
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(temp_path, target_path).map_err(|error| {
            format!(
                "Failed to move file into place {}: {error}",
                target_path.display()
            )
        })
    }
}

fn apply_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Failed to restrict file permissions {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_private_file_write_replaces_existing_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("settings.json");

        write_private_file_atomic(&path, b"old").expect("write initial file");
        write_private_file_atomic(&path, b"new").expect("replace file");

        assert_eq!(fs::read_to_string(path).expect("read file"), "new");
    }
}
