use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration as StdDuration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use time::{Date, Month, OffsetDateTime};

use crate::runtime::{ensure_runtime_log_files, load_effective_app_config_values};

const DESKTOP_APP_PROCESS_NAME: &str = "desktop-app";
const DESKTOP_SUPERVISOR_PROCESS_NAME: &str = "desktop-supervisor";
const DESKTOP_LOG_RETENTION_HOURS_KEY: &str = "DESKTOP_LOG_RETENTION_HOURS";
const HOURS_PER_LOG_DAY: u64 = 24;
const LOG_MAINTENANCE_INTERVAL: StdDuration = StdDuration::from_secs(60);

/// Starts periodic desktop log cleanup so retention changes apply without app relaunch.
pub(crate) fn start_desktop_log_maintenance(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("desktop-log-maintenance".to_owned())
        .spawn(move || {
            loop {
                if let Err(error) = maintain_desktop_logs_for_app(&app) {
                    append_desktop_log(
                        &app,
                        "warn",
                        &format!("Desktop log cleanup failed: {error}"),
                    );
                }
                thread::sleep(LOG_MAINTENANCE_INTERVAL);
            }
        });
}

fn maintain_desktop_logs_for_app(app: &AppHandle) -> Result<(), String> {
    provision_current_day_runtime_logs_for_app(app)?;
    cleanup_desktop_logs_for_app(app)?;
    Ok(())
}

/// Appends a line to the desktop app log file when the app-data path is available.
pub fn append_desktop_log(app: &AppHandle, level: &str, message: &str) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => return,
    };
    let logs_dir = app_data_dir.join("logs");
    let line = format_desktop_app_log_line(level, message);
    let _ = append_formatted_process_log(&logs_dir, DESKTOP_APP_PROCESS_NAME, &line);
}

/// Appends supervisor-owned lifecycle messages as JSON Lines.
pub(crate) fn append_desktop_supervisor_log(logs_dir: &Path, level: &str, message: &str) {
    let line = format_desktop_supervisor_log_line(level, message);
    let _ = append_formatted_process_log(logs_dir, DESKTOP_SUPERVISOR_PROCESS_NAME, &line);
}

/// Appends child-process output as parseable JSON Lines for Loki/Alloy ingestion.
pub(crate) fn append_child_process_log_line(
    logs_dir: &Path,
    process: &str,
    stream: &str,
    line: &str,
) {
    let line = format_child_process_log_line(process, stream, line);
    let _ = append_formatted_process_log(logs_dir, process, &line);
}

/// Returns the logical process name for a rotated or legacy `.log` file.
pub(crate) fn process_name_for_log_file(path: &Path) -> Option<String> {
    if !is_log_file(path) {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let process = split_dated_log_stem(stem)
        .map(|(process, _)| process)
        .unwrap_or(stem);
    Some(process.to_owned())
}

/// Returns true when a rotated or legacy `.log` file belongs to `process`.
pub(crate) fn log_file_belongs_to_process(path: &Path, process: &str) -> bool {
    process_name_for_log_file(path).as_deref() == Some(process)
}

/// Ensures the current UTC-day log file exists for a process without truncating it.
pub(crate) fn ensure_current_desktop_log_file(
    logs_dir: &Path,
    process: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(logs_dir)
        .map_err(|error| format!("Failed to create logs dir {}: {error}", logs_dir.display()))?;
    let file_path = current_daily_log_file_path(logs_dir, process);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|error| {
            format!(
                "Failed to provision desktop log file {}: {error}",
                file_path.display()
            )
        })?;
    Ok(file_path)
}

fn provision_current_day_runtime_logs_for_app(app: &AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    ensure_runtime_log_files(&app_data_dir.join("logs"))
}

/// Removes expired desktop logs according to the current manifest-backed setting.
pub(crate) fn cleanup_desktop_logs_for_app(
    app: &AppHandle,
) -> Result<DesktopLogCleanupSummary, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let logs_dir = app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| {
        format!(
            "Failed to create logs directory {}: {error}",
            logs_dir.display()
        )
    })?;
    let values = load_effective_app_config_values(app)?;
    let retention_hours = parse_log_retention_hours(
        values
            .get(DESKTOP_LOG_RETENTION_HOURS_KEY)
            .map(String::as_str),
    )?;
    cleanup_desktop_logs_dir(&logs_dir, retention_hours, OffsetDateTime::now_utc())
}

fn append_formatted_process_log(logs_dir: &Path, process: &str, line: &str) -> Result<(), String> {
    let mut file = open_daily_log_file(logs_dir, process)
        .map_err(|error| format!("Failed to open desktop log for {process}: {error}"))?;
    writeln!(file, "{line}")
        .map_err(|error| format!("Failed to write desktop log for {process}: {error}"))
}

fn open_daily_log_file(logs_dir: &Path, process: &str) -> Result<File, std::io::Error> {
    fs::create_dir_all(logs_dir)?;
    let file_path = current_daily_log_file_path(logs_dir, process);
    OpenOptions::new().create(true).append(true).open(file_path)
}

/// Returns the current UTC-day app-data log path for a process.
pub(crate) fn current_daily_log_file_path(logs_dir: &Path, process: &str) -> PathBuf {
    daily_log_file_path_for_date(logs_dir, process, OffsetDateTime::now_utc().date())
}

fn daily_log_file_path_for_date(logs_dir: &Path, process: &str, date: Date) -> PathBuf {
    logs_dir.join(format!("{process}-{}.log", format_utc_date(date)))
}

/// Formats child-process output as parseable JSON Lines for Loki/Alloy ingestion.
fn format_child_process_log_line(process: &str, stream: &str, line: &str) -> String {
    format_child_process_log_line_at(process, stream, line, &rfc3339_now())
}

/// Formats supervisor-owned lifecycle messages as parseable JSON Lines.
fn format_desktop_supervisor_log_line(level: &str, message: &str) -> String {
    format_desktop_component_log_line(
        DESKTOP_SUPERVISOR_PROCESS_NAME,
        "DesktopSupervisor",
        level,
        level,
        "supervisor",
        message,
        &rfc3339_now(),
    )
}

fn format_desktop_app_log_line(level: &str, message: &str) -> String {
    format_desktop_component_log_line(
        DESKTOP_APP_PROCESS_NAME,
        "DesktopApp",
        level,
        level,
        "desktop_app",
        message,
        &rfc3339_now(),
    )
}

fn format_child_process_log_line_at(
    process: &str,
    stream: &str,
    line: &str,
    timestamp: &str,
) -> String {
    if let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(line) {
        let fallback_action = json_string_field(&object, "event")
            .unwrap_or(stream)
            .to_owned();
        ensure_json_string_field(&mut object, "t", timestamp);
        ensure_json_string_field(&mut object, "level", fallback_level_for_stream(stream));
        ensure_json_string_field(&mut object, "component", process);
        ensure_json_string_field(&mut object, "action", &fallback_action);
        ensure_json_string_field(&mut object, "process", process);
        ensure_json_string_field(&mut object, "stream", stream);
        return Value::Object(object).to_string();
    }

    format_desktop_component_log_line(
        process,
        process,
        fallback_level_for_stream(stream),
        stream,
        stream,
        line,
        timestamp,
    )
}

fn format_desktop_component_log_line(
    process: &str,
    component: &str,
    level: &str,
    stream: &str,
    action: &str,
    message: &str,
    timestamp: &str,
) -> String {
    let payload = DesktopJsonLogLine {
        t: timestamp,
        level,
        component,
        action,
        process,
        stream,
        msg: message,
    };
    serde_json::to_string(&payload)
        .unwrap_or_else(|_| "{\"level\":\"error\",\"msg\":\"failed to encode desktop log\"}".into())
}

fn cleanup_desktop_logs_dir(
    logs_dir: &Path,
    retention_hours: u64,
    now: OffsetDateTime,
) -> Result<DesktopLogCleanupSummary, String> {
    let oldest_retained_day = oldest_retained_julian_day(retention_hours, now)?;
    let mut summary = DesktopLogCleanupSummary::default();
    let mut errors = Vec::<String>::new();

    let entries = fs::read_dir(logs_dir).map_err(|error| {
        format!(
            "Failed to read logs directory {}: {error}",
            logs_dir.display()
        )
    })?;

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !is_log_file(&path) {
            continue;
        }

        let should_delete = match dated_log_file_date(&path) {
            Some(date) => date.to_julian_day() < oldest_retained_day,
            None => true,
        };
        if should_delete {
            match fs::remove_file(&path) {
                Ok(()) => summary.deleted += 1,
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            }
        } else {
            summary.kept += 1;
        }
    }

    if errors.is_empty() {
        Ok(summary)
    } else {
        Err(format!(
            "Failed to remove expired log files: {}",
            errors.join("; ")
        ))
    }
}

fn oldest_retained_julian_day(retention_hours: u64, now: OffsetDateTime) -> Result<i32, String> {
    let retained_days = retained_log_day_count(retention_hours)?;
    Ok(now.date().to_julian_day() - (retained_days - 1))
}

fn retained_log_day_count(retention_hours: u64) -> Result<i32, String> {
    if retention_hours == 0 {
        return Err(format!(
            "{DESKTOP_LOG_RETENTION_HOURS_KEY} must be at least 1"
        ));
    }
    let retained_days = retention_hours.div_ceil(HOURS_PER_LOG_DAY);
    i32::try_from(retained_days)
        .map_err(|_| format!("{DESKTOP_LOG_RETENTION_HOURS_KEY} is too large: {retention_hours}"))
}

fn parse_log_retention_hours(raw: Option<&str>) -> Result<u64, String> {
    let value = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {DESKTOP_LOG_RETENTION_HOURS_KEY}"))?;
    let parsed = value.parse::<u64>().map_err(|error| {
        format!("Invalid {DESKTOP_LOG_RETENTION_HOURS_KEY} value \"{value}\": {error}")
    })?;
    if parsed == 0 {
        return Err(format!(
            "{DESKTOP_LOG_RETENTION_HOURS_KEY} must be at least 1"
        ));
    }
    Ok(parsed)
}

fn dated_log_file_date(path: &Path) -> Option<Date> {
    let stem = path.file_stem()?.to_str()?;
    let (_, date) = split_dated_log_stem(stem)?;
    parse_log_date(date)
}

fn split_dated_log_stem(stem: &str) -> Option<(&str, &str)> {
    if stem.len() < 12 {
        return None;
    }
    let date_start = stem.len() - 10;
    if stem.as_bytes().get(date_start.wrapping_sub(1)) != Some(&b'-') {
        return None;
    }
    let process = &stem[..date_start - 1];
    let date = &stem[date_start..];
    if process.is_empty() || !is_log_date_text(date) {
        return None;
    }
    Some((process, date))
}

fn is_log_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("log"))
        .unwrap_or(false)
}

fn is_log_date_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn parse_log_date(value: &str) -> Option<Date> {
    if !is_log_date_text(value) {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = Month::try_from(value[5..7].parse::<u8>().ok()?).ok()?;
    let day = value[8..10].parse::<u8>().ok()?;
    Date::from_calendar_date(year, month, day).ok()
}

fn format_utc_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

fn ensure_json_string_field(object: &mut Map<String, Value>, key: &str, fallback: &str) {
    let has_non_empty_string = object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if !has_non_empty_string {
        object.insert(key.to_owned(), Value::String(fallback.to_owned()));
    }
}

fn json_string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn fallback_level_for_stream(stream: &str) -> &str {
    match stream {
        "stderr" | "error" => "error",
        "warn" | "warning" => "warn",
        "debug" => "debug",
        _ => "info",
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DesktopLogCleanupSummary {
    pub deleted: usize,
    pub kept: usize,
}

#[derive(Serialize)]
struct DesktopJsonLogLine<'a> {
    t: &'a str,
    level: &'a str,
    component: &'a str,
    action: &'a str,
    process: &'a str,
    stream: &'a str,
    msg: &'a str,
}

fn rfc3339_now() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

#[cfg(test)]
mod tests {
    use time::Time;

    use super::*;

    const TEST_TS: &str = "2026-06-01T12:00:00Z";

    #[test]
    fn daily_log_file_path_uses_utc_day_suffix() {
        let logs_dir = Path::new("/logs");
        let date = test_date(2026, Month::June, 1);

        let path = daily_log_file_path_for_date(logs_dir, "trading-bidding-bot", date);

        assert_eq!(
            path,
            PathBuf::from("/logs/trading-bidding-bot-2026-06-01.log")
        );
    }

    #[test]
    fn process_name_for_log_file_strips_day_suffix() {
        let path = Path::new("/logs/trading-bidding-bot-2026-06-01.log");

        assert_eq!(
            process_name_for_log_file(path),
            Some("trading-bidding-bot".to_owned())
        );
        assert!(log_file_belongs_to_process(path, "trading-bidding-bot"));
    }

    #[test]
    fn cleanup_with_48_hours_keeps_current_and_previous_day() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_log(temp.path(), "trading-bidding-bot-2026-05-31.log");
        write_log(temp.path(), "trading-bidding-bot-2026-06-01.log");
        write_log(temp.path(), "trading-bidding-bot-2026-06-02.log");
        write_log(temp.path(), "trading-bidding-bot.log");

        let summary = cleanup_desktop_logs_dir(temp.path(), 48, test_now(2026, Month::June, 2))
            .expect("cleanup logs");

        assert_eq!(summary.deleted, 2);
        assert_eq!(summary.kept, 2);
        assert!(
            !temp
                .path()
                .join("trading-bidding-bot-2026-05-31.log")
                .exists()
        );
        assert!(!temp.path().join("trading-bidding-bot.log").exists());
        assert!(
            temp.path()
                .join("trading-bidding-bot-2026-06-01.log")
                .exists()
        );
        assert!(
            temp.path()
                .join("trading-bidding-bot-2026-06-02.log")
                .exists()
        );
    }

    #[test]
    fn cleanup_with_24_hours_keeps_only_current_day() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_log(temp.path(), "backend-2026-06-01.log");
        write_log(temp.path(), "backend-2026-06-02.log");

        let summary = cleanup_desktop_logs_dir(temp.path(), 24, test_now(2026, Month::June, 2))
            .expect("cleanup logs");

        assert_eq!(summary.deleted, 1);
        assert_eq!(summary.kept, 1);
        assert!(!temp.path().join("backend-2026-06-01.log").exists());
        assert!(temp.path().join("backend-2026-06-02.log").exists());
    }

    #[test]
    fn child_process_json_lines_keep_json_at_start() {
        let line = format_child_process_log_line_at(
            "backend",
            "stdout",
            r#"{"t":"2026-06-01T11:59:59.000Z","level":"info","msg":"ready","component":"BackendApi","action":"startup"}"#,
            TEST_TS,
        );

        assert!(!line.starts_with("[stdout]"));
        let payload: Value = serde_json::from_str(&line).expect("log line should be JSON");
        assert_eq!(payload["t"], "2026-06-01T11:59:59.000Z");
        assert_eq!(payload["level"], "info");
        assert_eq!(payload["component"], "BackendApi");
        assert_eq!(payload["action"], "startup");
        assert_eq!(payload["process"], "backend");
        assert_eq!(payload["stream"], "stdout");
        assert_eq!(payload["msg"], "ready");
    }

    #[test]
    fn child_process_plain_lines_are_wrapped_as_json() {
        let line =
            format_child_process_log_line_at("nats", "stderr", "server failed to bind", TEST_TS);

        let payload: Value = serde_json::from_str(&line).expect("log line should be JSON");
        assert_eq!(payload["t"], TEST_TS);
        assert_eq!(payload["level"], "error");
        assert_eq!(payload["component"], "nats");
        assert_eq!(payload["action"], "stderr");
        assert_eq!(payload["process"], "nats");
        assert_eq!(payload["stream"], "stderr");
        assert_eq!(payload["msg"], "server failed to bind");
    }

    #[test]
    fn lifecycle_json_gets_observability_fields() {
        let line = format_child_process_log_line_at(
            "trading-bidding-bot",
            "lifecycle",
            r#"{"event":"bot_ready","botKind":"bidding"}"#,
            TEST_TS,
        );

        let payload: Value = serde_json::from_str(&line).expect("log line should be JSON");
        assert_eq!(payload["t"], TEST_TS);
        assert_eq!(payload["level"], "info");
        assert_eq!(payload["component"], "trading-bidding-bot");
        assert_eq!(payload["action"], "bot_ready");
        assert_eq!(payload["process"], "trading-bidding-bot");
        assert_eq!(payload["stream"], "lifecycle");
        assert_eq!(payload["event"], "bot_ready");
    }

    fn test_now(year: i32, month: Month, day: u8) -> OffsetDateTime {
        test_date(year, month, day)
            .with_time(Time::from_hms(0, 1, 0).expect("valid test time"))
            .assume_utc()
    }

    fn test_date(year: i32, month: Month, day: u8) -> Date {
        Date::from_calendar_date(year, month, day).expect("valid test date")
    }

    fn write_log(dir: &Path, name: &str) {
        fs::write(dir.join(name), "{}\n").expect("write test log");
    }
}
