use std::fs::{self, OpenOptions};
use std::io::Write;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use time::OffsetDateTime;

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
    let _ = writeln!(file, "{}", format_desktop_app_log_line(level, message));
}

/// Formats child-process output as parseable JSON Lines for Loki/Alloy ingestion.
pub(crate) fn format_child_process_log_line(process: &str, stream: &str, line: &str) -> String {
    format_child_process_log_line_at(process, stream, line, &rfc3339_now())
}

/// Formats supervisor-owned lifecycle messages as parseable JSON Lines.
pub(crate) fn format_desktop_supervisor_log_line(level: &str, message: &str) -> String {
    format_desktop_component_log_line(
        "desktop-supervisor",
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
        "desktop-app",
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
    use serde_json::Value;

    use super::*;

    const TEST_TS: &str = "2026-06-01T12:00:00Z";

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
}
