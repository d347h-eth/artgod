//! Narrow WebView-to-file boundary. No configuration, headers or response bodies are accepted.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

use crate::desktop_log::append_desktop_lifecycle_log;
use crate::runtime::{RuntimeManager, RuntimeStatus};

const MAX_METADATA_FIELDS: usize = 64;
const MAX_METADATA_STRING_BYTES: usize = 4096;
const MAX_RECORD_BYTES: usize = 48 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LifecycleDiagnostic {
    session_id: String,
    event_id: u64,
    client_at_iso: String,
    level: DiagnosticLevel,
    code: String,
    message: String,
    meta: BTreeMap<String, DiagnosticValue>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DiagnosticLevel {
    Info,
    Warn,
    Error,
}

impl DiagnosticLevel {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum DiagnosticValue {
    String(String),
    Number(f64),
    Boolean(bool),
}

impl LifecycleDiagnostic {
    fn validate(&self) -> Result<(), String> {
        if self.session_id.is_empty()
            || self.session_id.len() > 128
            || self.client_at_iso.len() > 64
            || self.code.is_empty()
            || self.code.len() > 128
            || self.message.len() > 4096
            || self.meta.len() > MAX_METADATA_FIELDS
            || self.meta.iter().any(|(key, value)| {
                key.len() > 128
                    || matches!(value, DiagnosticValue::String(text) if text.len() > MAX_METADATA_STRING_BYTES)
                    || matches!(value, DiagnosticValue::Number(number) if !number.is_finite())
            })
            || serde_json::to_vec(self)
                .map_err(|error| error.to_string())?
                .len()
                > MAX_RECORD_BYTES
        {
            return Err("Desktop lifecycle diagnostic exceeds log limits".to_owned());
        }
        Ok(())
    }
}

/// Include only the native status fields needed to compare WebView and supervisor readiness.
pub(crate) fn runtime_context(status: Result<RuntimeStatus, String>) -> serde_json::Value {
    match status {
        Ok(status) => serde_json::json!({
            "state": status.state,
            "operationId": status.operation_id,
            "revision": status.revision,
            "startup": status.startup,
            "runningProcesses": status.running_processes,
            "backendHttpBaseUrl": status.backend_http_base_url,
        }),
        Err(_) => serde_json::json!({ "statusAvailable": false }),
    }
}

pub(crate) fn record_lifecycle_diagnostic(
    app: &AppHandle,
    window: &WebviewWindow,
    runtime: &RuntimeManager,
    diagnostic: LifecycleDiagnostic,
) -> Result<(), String> {
    diagnostic.validate()?;
    let mut window_url = window.url().map_err(|error| error.to_string())?;
    // URLs may acquire query tokens; diagnostic context never needs them or userinfo.
    window_url.set_query(None);
    window_url.set_fragment(None);
    let _ = window_url.set_username("");
    let _ = window_url.set_password(None);
    let details = serde_json::json!({
        "sessionId": diagnostic.session_id,
        "eventId": diagnostic.event_id,
        "clientAtIso": diagnostic.client_at_iso,
        "meta": diagnostic.meta,
        "webview": { "label": window.label(), "url": window_url.as_str() },
        "nativeRuntime": runtime_context(runtime.status()),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "debugBuild": cfg!(debug_assertions),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    });
    append_desktop_lifecycle_log(
        app,
        diagnostic.level.as_str(),
        &diagnostic.code,
        &diagnostic.message,
        &details,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire_record() -> serde_json::Value {
        serde_json::json!({
            "sessionId": "test-session", "eventId": 3,
            "clientAtIso": "2026-10-01T19:29:12.000Z", "level": "warn",
            "code": "api.retry", "message": "Retrying backend request",
            "meta": { "attempt": 1, "frontendOrigin": "tauri://localhost", "aborted": false },
        })
    }

    #[test]
    fn accepts_frontend_wire_record_and_rejects_nested_payloads_and_unknown_levels() {
        let input: LifecycleDiagnostic = serde_json::from_value(wire_record()).unwrap();
        input.validate().unwrap();
        let mut record = wire_record();
        record["meta"]["body"] = serde_json::json!({ "secret": "excluded" });
        assert!(serde_json::from_value::<LifecycleDiagnostic>(record).is_err());
        let mut record = wire_record();
        record["level"] = serde_json::json!("custom");
        assert!(serde_json::from_value::<LifecycleDiagnostic>(record).is_err());
    }

    #[test]
    fn rejects_oversized_metadata_and_record() {
        let mut input: LifecycleDiagnostic = serde_json::from_value(wire_record()).unwrap();
        input.meta.insert(
            "errorStack".into(),
            DiagnosticValue::String("x".repeat(4097)),
        );
        assert!(input.validate().is_err());
        input.meta.clear();
        for i in 0..64 {
            input
                .meta
                .insert(i.to_string(), DiagnosticValue::String("x".repeat(4096)));
        }
        assert!(input.validate().is_err());
    }

    #[test]
    fn native_context_excludes_config_and_nats_credentials() {
        let runtime = RuntimeManager::new();
        let context = runtime_context(runtime.status());
        assert!(context.get("operationId").is_some());
        assert!(context.get("configPath").is_none());
        assert!(context.get("natsUrl").is_none());
    }
}
