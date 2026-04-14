use std::fs::{self, OpenOptions};
use std::io::Write;

use tauri::{AppHandle, Manager};

/// Appends a line to the desktop app log file when the app-data path is available.
pub fn append_desktop_log(app: &AppHandle, level: &str, message: &str) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => return,
    };
    let logs_dir = app_data_dir.join("logs");
    if fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let file_path = logs_dir.join("desktop-app.log");
    let mut file = match OpenOptions::new().create(true).append(true).open(file_path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let _ = writeln!(file, "[{}] [{}] {}", rfc3339_now(), level, message);
}

fn rfc3339_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown-time".to_owned())
}
