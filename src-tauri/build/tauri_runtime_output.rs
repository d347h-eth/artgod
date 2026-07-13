use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};

// Matches the profile-output derivation used by the pinned tauri-build crate.
const PROFILE_OUTPUT_ANCESTOR_DEPTH: usize = 3;

/// Removes only Tauri's copied runtime tree so obsolete content-hashed files cannot survive.
pub(crate) fn reconcile_tauri_runtime_output(
    cargo_output_dir: &Path,
    bundled_runtime_relative_path: &Path,
) -> Result<(), String> {
    validate_relative_path(bundled_runtime_relative_path)?;
    let profile_output_dir = profile_output_dir(cargo_output_dir)?;
    let copied_runtime_dir = profile_output_dir.join(bundled_runtime_relative_path);
    let metadata = match fs::symlink_metadata(&copied_runtime_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect copied Tauri runtime output {}: {error}",
                copied_runtime_dir.display()
            ));
        }
    };

    // Remove links and non-directories as leaves without following them.
    let result = if metadata.file_type().is_symlink() {
        remove_symlink_leaf(&copied_runtime_dir)
    } else if metadata.is_dir() {
        fs::remove_dir_all(&copied_runtime_dir)
    } else {
        fs::remove_file(&copied_runtime_dir)
    };
    result.map_err(|error| {
        format!(
            "Failed to reconcile copied Tauri runtime output {}: {error}",
            copied_runtime_dir.display()
        )
    })
}

/// Copies the staged runtime beside a no-bundle executable after Tauri's build step.
pub(crate) fn copy_staged_runtime_to_tauri_output(
    cargo_output_dir: &Path,
    staged_runtime_dir: &Path,
    bundled_runtime_relative_path: &Path,
) -> Result<(), String> {
    validate_relative_path(bundled_runtime_relative_path)?;
    validate_runtime_source_tree(staged_runtime_dir)?;

    // Replace the complete copied runtime so obsolete generated files cannot survive.
    reconcile_tauri_runtime_output(cargo_output_dir, bundled_runtime_relative_path)?;
    let destination = profile_output_dir(cargo_output_dir)?.join(bundled_runtime_relative_path);
    copy_runtime_source_tree(staged_runtime_dir, &destination)
}

pub(crate) fn profile_output_dir(cargo_output_dir: &Path) -> Result<&Path, String> {
    cargo_output_dir
        .ancestors()
        .nth(PROFILE_OUTPUT_ANCESTOR_DEPTH)
        .ok_or_else(|| {
            format!(
                "Cargo OUT_DIR does not contain a profile output directory: {}",
                cargo_output_dir.display()
            )
        })
}

fn validate_runtime_source_tree(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect staged desktop runtime {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Staged desktop runtime must not contain symbolic links: {}",
            path.display()
        ));
    }
    if metadata.is_file() {
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "Staged desktop runtime contains an unsupported file type: {}",
            path.display()
        ));
    }

    for entry in fs::read_dir(path).map_err(|error| {
        format!(
            "Failed to read staged desktop runtime directory {}: {error}",
            path.display()
        )
    })? {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to read staged desktop runtime entry below {}: {error}",
                path.display()
            )
        })?;
        validate_runtime_source_tree(&entry.path())?;
    }
    Ok(())
}

fn copy_runtime_source_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        format!(
            "Failed to inspect staged desktop runtime {}: {error}",
            source.display()
        )
    })?;
    if metadata.is_file() {
        fs::copy(source, destination).map_err(|error| {
            format!(
                "Failed to copy staged desktop runtime file {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
        return Ok(());
    }

    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Failed to create copied desktop runtime directory {}: {error}",
            destination.display()
        )
    })?;
    for entry in fs::read_dir(source).map_err(|error| {
        format!(
            "Failed to read staged desktop runtime directory {}: {error}",
            source.display()
        )
    })? {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to read staged desktop runtime entry below {}: {error}",
                source.display()
            )
        })?;
        copy_runtime_source_tree(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn remove_symlink_leaf(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path)
}

#[cfg(windows)]
fn remove_symlink_leaf(path: &Path) -> std::io::Result<()> {
    // Windows uses separate APIs for file and directory symbolic links.
    fs::remove_dir(path).or_else(|_| fs::remove_file(path))
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "Tauri runtime output path must be normalized and relative: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_contract::BUNDLED_RUNTIME_RELATIVE_PATH;
    use std::path::PathBuf;

    fn synthetic_out_dir(root: &Path, profile_prefix: &str) -> PathBuf {
        root.join(profile_prefix)
            .join("build/artgod-desktop-test/out")
    }

    fn write_file(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().expect("test file parent"))
            .expect("create test file parent");
        fs::write(path, contents).expect("write test file");
    }

    #[test]
    fn removes_only_the_copied_runtime_tree_from_default_profile_output() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");
        let runtime_relative = Path::new(BUNDLED_RUNTIME_RELATIVE_PATH);
        let profile_output = out_dir.ancestors().nth(3).expect("profile output");
        let stale_chunk = profile_output
            .join(runtime_relative)
            .join("trading/dist-desktop/chunks/stale.mjs");
        let sibling_resource = profile_output.join("resources/keep.txt");
        let compiled_dependency = profile_output.join("deps/libkeep.rlib");
        write_file(&stale_chunk, b"stale");
        write_file(&sibling_resource, b"keep");
        write_file(&compiled_dependency, b"keep");

        reconcile_tauri_runtime_output(&out_dir, runtime_relative).expect("reconcile output");

        assert!(!profile_output.join(runtime_relative).exists());
        assert!(sibling_resource.is_file());
        assert!(compiled_dependency.is_file());
    }

    #[test]
    fn supports_target_triples_and_custom_cargo_target_roots() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(
            temp.path(),
            "custom-cargo-target/x86_64-unknown-linux-gnu/release",
        );
        let runtime_relative = Path::new(BUNDLED_RUNTIME_RELATIVE_PATH);
        let copied_runtime = out_dir
            .ancestors()
            .nth(3)
            .expect("profile output")
            .join(runtime_relative);
        write_file(&copied_runtime.join("trading/obsolete.mjs"), b"obsolete");

        reconcile_tauri_runtime_output(&out_dir, runtime_relative).expect("reconcile output");

        assert!(!copied_runtime.exists());
    }

    #[test]
    fn copies_the_exact_staged_runtime_without_removing_sibling_outputs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");
        let runtime_relative = Path::new(BUNDLED_RUNTIME_RELATIVE_PATH);
        let staged_runtime = temp.path().join("staged-runtime");
        let profile_output = out_dir.ancestors().nth(3).expect("profile output");
        let copied_runtime = profile_output.join(runtime_relative);
        let sibling_resource = profile_output.join("resources/keep.txt");
        write_file(
            &staged_runtime.join("trading/dist-desktop/index.mjs"),
            b"current",
        );
        write_file(&staged_runtime.join("node/node"), b"node");
        write_file(&copied_runtime.join("trading/stale.mjs"), b"stale");
        write_file(&sibling_resource, b"keep");

        copy_staged_runtime_to_tauri_output(&out_dir, &staged_runtime, runtime_relative)
            .expect("copy staged runtime");

        assert_eq!(
            fs::read(copied_runtime.join("trading/dist-desktop/index.mjs"))
                .expect("read copied artifact"),
            b"current"
        );
        assert_eq!(
            fs::read(copied_runtime.join("node/node")).expect("read copied node"),
            b"node"
        );
        assert!(!copied_runtime.join("trading/stale.mjs").exists());
        assert!(sibling_resource.is_file());
    }

    #[test]
    fn missing_staged_runtime_fails_before_reconciling_existing_output() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");
        let runtime_relative = Path::new(BUNDLED_RUNTIME_RELATIVE_PATH);
        let copied_runtime = out_dir
            .ancestors()
            .nth(3)
            .expect("profile output")
            .join(runtime_relative);
        let existing_file = copied_runtime.join("trading/existing.mjs");
        write_file(&existing_file, b"existing");

        let error = copy_staged_runtime_to_tauri_output(
            &out_dir,
            &temp.path().join("missing-runtime"),
            runtime_relative,
        )
        .expect_err("missing staged runtime must fail");

        assert!(error.contains("Failed to inspect staged desktop runtime"));
        assert!(existing_file.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn staged_runtime_symlinks_fail_before_reconciling_existing_output() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");
        let runtime_relative = Path::new(BUNDLED_RUNTIME_RELATIVE_PATH);
        let staged_runtime = temp.path().join("staged-runtime");
        let copied_runtime = out_dir
            .ancestors()
            .nth(3)
            .expect("profile output")
            .join(runtime_relative);
        let existing_file = copied_runtime.join("trading/existing.mjs");
        let outside_file = temp.path().join("outside.mjs");
        write_file(&staged_runtime.join("trading/index.mjs"), b"current");
        write_file(&existing_file, b"existing");
        write_file(&outside_file, b"outside");
        symlink(&outside_file, staged_runtime.join("trading/dependency.mjs"))
            .expect("create staged runtime symlink");

        let error =
            copy_staged_runtime_to_tauri_output(&out_dir, &staged_runtime, runtime_relative)
                .expect_err("staged runtime symlink must fail");

        assert!(error.contains("must not contain symbolic links"));
        assert!(existing_file.is_file());
    }

    #[test]
    fn missing_copied_runtime_tree_is_an_idempotent_success() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/debug");

        reconcile_tauri_runtime_output(&out_dir, Path::new(BUNDLED_RUNTIME_RELATIVE_PATH))
            .expect("missing output is already reconciled");
    }

    #[cfg(unix)]
    #[test]
    fn removes_a_runtime_symlink_without_following_it() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");
        let profile_output = out_dir.ancestors().nth(3).expect("profile output");
        let outside = temp.path().join("outside/keep.mjs");
        let copied_runtime = profile_output.join(BUNDLED_RUNTIME_RELATIVE_PATH);
        write_file(&outside, b"keep");
        fs::create_dir_all(copied_runtime.parent().expect("runtime parent"))
            .expect("create runtime parent");
        symlink(outside.parent().expect("outside parent"), &copied_runtime)
            .expect("create runtime symlink");

        reconcile_tauri_runtime_output(&out_dir, Path::new(BUNDLED_RUNTIME_RELATIVE_PATH))
            .expect("remove symlink leaf");

        assert!(!copied_runtime.exists());
        assert!(outside.is_file());
    }

    #[test]
    fn rejects_non_normalized_runtime_output_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");

        let error = reconcile_tauri_runtime_output(&out_dir, Path::new("../runtime"))
            .expect_err("parent traversal must fail");

        assert!(error.contains("normalized and relative"));
    }

    #[test]
    fn rejects_an_empty_runtime_output_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let out_dir = synthetic_out_dir(temp.path(), "target/release");

        let error = reconcile_tauri_runtime_output(&out_dir, Path::new(""))
            .expect_err("empty output path must fail");

        assert!(error.contains("normalized and relative"));
    }
}
