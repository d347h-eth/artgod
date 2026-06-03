use std::fs::{self, OpenOptions};
use std::path::Path;

use super::process_registry::runtime_log_process_names;

/// Ensures known desktop runtime log files exist without truncating user logs.
pub(crate) fn ensure_runtime_log_files(logs_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(logs_dir)
        .map_err(|error| format!("Failed to create logs dir {}: {error}", logs_dir.display()))?;

    for process_name in runtime_log_process_names() {
        let file_path = logs_dir.join(format!("{process_name}.log"));
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .map_err(|error| {
                format!(
                    "Failed to provision runtime log file {}: {error}",
                    file_path.display()
                )
            })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use super::*;

    #[test]
    fn provisions_bot_log_files_before_bot_process_start() {
        let temp = tempfile::tempdir().expect("tempdir");
        let logs_dir = temp.path().join("logs");

        ensure_runtime_log_files(&logs_dir).expect("runtime logs should provision");

        assert!(logs_dir.join("trading-bidding-bot.log").exists());
        assert!(logs_dir.join("trading-sniping-bot.log").exists());
    }

    #[test]
    fn does_not_truncate_existing_runtime_log_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let logs_dir = temp.path().join("logs");
        fs::create_dir_all(&logs_dir).expect("logs dir");
        let bidding_log_path = logs_dir.join("trading-bidding-bot.log");
        let mut existing = fs::File::create(&bidding_log_path).expect("existing log");
        writeln!(existing, "existing line").expect("write existing log");

        ensure_runtime_log_files(&logs_dir).expect("runtime logs should provision");

        let content = fs::read_to_string(&bidding_log_path).expect("read existing log");
        assert_eq!(content, "existing line\n");
    }
}
