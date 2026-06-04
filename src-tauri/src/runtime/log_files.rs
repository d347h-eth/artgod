use std::fs;
use std::path::Path;

use super::process_registry::runtime_log_process_names;
use crate::desktop_log::ensure_current_desktop_log_file;

/// Ensures known desktop runtime log files exist for the current UTC day.
pub(crate) fn ensure_runtime_log_files(logs_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(logs_dir)
        .map_err(|error| format!("Failed to create logs dir {}: {error}", logs_dir.display()))?;

    for process_name in runtime_log_process_names() {
        ensure_current_desktop_log_file(logs_dir, process_name)
            .map_err(|error| format!("Failed to provision {process_name} runtime log: {error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use super::*;
    use crate::desktop_log::current_daily_log_file_path;

    #[test]
    fn provisions_bot_log_files_before_bot_process_start() {
        let temp = tempfile::tempdir().expect("tempdir");
        let logs_dir = temp.path().join("logs");

        ensure_runtime_log_files(&logs_dir).expect("runtime logs should provision");

        assert!(current_daily_log_file_path(&logs_dir, "trading-bidding-bot").exists());
        assert!(current_daily_log_file_path(&logs_dir, "trading-sniping-bot").exists());
    }

    #[test]
    fn does_not_truncate_existing_runtime_log_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let logs_dir = temp.path().join("logs");
        fs::create_dir_all(&logs_dir).expect("logs dir");
        let bidding_log_path = current_daily_log_file_path(&logs_dir, "trading-bidding-bot");
        let mut existing = fs::File::create(&bidding_log_path).expect("existing log");
        writeln!(existing, "existing line").expect("write existing log");

        ensure_runtime_log_files(&logs_dir).expect("runtime logs should provision");

        let content = fs::read_to_string(&bidding_log_path).expect("read existing log");
        assert_eq!(content, "existing line\n");
    }
}
