//! Bounded WebView-to-file diagnostics and a direct comparison with local HTTP readiness.
use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

use crate::desktop_log::append_desktop_lifecycle_log;
use crate::runtime::{RuntimeManager, RuntimeStatus, runtime_api_routes};

const MAX_METADATA_FIELDS: usize = 64;
const MAX_METADATA_STRING_BYTES: usize = 4096;
const MAX_RECORD_BYTES: usize = 48 * 1024;
const COMPARISON_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_HEALTH_BODY_BYTES: usize = 4096;
const BACKEND_COMPARISON_ACTION: &str = "api.request.native-check";

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
    #[serde(default)]
    compare_backend: bool,
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
    diagnostic: &LifecycleDiagnostic,
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

/// A direct, non-retrying loopback comparison; it never decides readiness or starts services.
pub(crate) async fn record_backend_comparison(
    app: &AppHandle,
    runtime: &RuntimeManager,
    diagnostic: &LifecycleDiagnostic,
) -> Result<(), String> {
    if !diagnostic.compare_backend {
        return Ok(());
    }
    let before = runtime.status()?;
    let requested_operation = match diagnostic.meta.get("runtimeOperationId") {
        Some(DiagnosticValue::Number(value)) => *value,
        _ => -1.0,
    };
    let result = if before.operation_id as f64 != requested_operation || before.state != "running" {
        serde_json::json!({ "skipped": "runtime-operation-changed" })
    } else {
        compare_backend(
            &before.backend_http_base_url,
            diagnostic.meta.get("frontendOrigin"),
        )
        .await
    };
    append_desktop_lifecycle_log(
        app,
        "info",
        BACKEND_COMPARISON_ACTION,
        "Native HTTP comparison for WebView readiness failure",
        &serde_json::json!({
            "sessionId": diagnostic.session_id,
            "eventId": diagnostic.event_id,
            "clientAtIso": diagnostic.client_at_iso,
            "nativeRuntimeBefore": runtime_context(Ok(before)),
            "nativeRuntimeAfter": runtime_context(runtime.status()),
            "comparison": result,
        }),
    )
}

async fn compare_backend(
    base_url: &str,
    frontend_origin: Option<&DiagnosticValue>,
) -> serde_json::Value {
    let Ok(base) = reqwest::Url::parse(base_url) else {
        return serde_json::json!({ "skipped": "backend-url-unavailable" });
    };
    // Never accept a target from the WebView or follow a redirect out of local infra.
    if base.scheme() != "http"
        || base
            .host_str()
            .and_then(|host| host.parse::<Ipv4Addr>().ok())
            != Some(Ipv4Addr::LOCALHOST)
        || !base.username().is_empty()
        || base.password().is_some()
    {
        return serde_json::json!({ "skipped": "backend-url-is-not-local-infra" });
    }
    let origin = match frontend_origin {
        Some(DiagnosticValue::String(value)) => value.as_str(),
        _ => "",
    };
    // Ordinary catalog/RPC clients retry and deserialize domain bodies. This diagnostic needs
    // one direct response's CORS headers even on errors, with no proxy or redirect fallback.
    let client = match reqwest::Client::builder()
        .timeout(COMPARISON_TIMEOUT)
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return serde_json::json!({ "error": "native-http-client-unavailable" }),
    };
    let routes = runtime_api_routes();
    let (health, chain) = futures_util::join!(
        inspect_response(&client, &base, &routes.health, origin, true),
        inspect_response(&client, &base, &routes.default_chain, origin, false),
    );
    serde_json::json!({
        "frontendOrigin": origin,
        "proxyBypassed": true,
        "redirectsFollowed": false,
        "timeoutMs": COMPARISON_TIMEOUT.as_millis(),
        "health": health,
        "defaultChain": chain,
    })
}

async fn inspect_response(
    client: &reqwest::Client,
    base: &reqwest::Url,
    path: &str,
    origin: &str,
    read_health: bool,
) -> serde_json::Value {
    let started = Instant::now();
    let mut url = base.clone();
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    let request = client.get(url).header(reqwest::header::CONNECTION, "close");
    let request = if origin.is_empty() {
        request
    } else {
        request.header(reqwest::header::ORIGIN, origin)
    };
    let mut result = serde_json::json!({ "path": path });
    match request.send().await {
        Ok(mut response) => {
            result["httpStatus"] = response.status().as_u16().into();
            for (field, header) in [
                ("contentType", reqwest::header::CONTENT_TYPE),
                ("allowOrigin", reqwest::header::ACCESS_CONTROL_ALLOW_ORIGIN),
                (
                    "allowCredentials",
                    reqwest::header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                ),
            ] {
                result[field] = response
                    .headers()
                    .get(header)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .chars()
                    .take(1000)
                    .collect::<String>()
                    .into();
            }
            if read_health {
                let mut body = Vec::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_HEALTH_BODY_BYTES => {
                            body.extend_from_slice(&chunk)
                        }
                        Ok(None) => {
                            let ok = serde_json::from_slice::<serde_json::Value>(&body)
                                .ok()
                                .and_then(|payload| {
                                    payload.get("ok").and_then(serde_json::Value::as_bool)
                                });
                            result["runtimeHealthOk"] = serde_json::json!(ok);
                            break;
                        }
                        Ok(Some(_)) => {
                            result["bodyError"] = "health-response-too-large".into();
                            break;
                        }
                        Err(error) => {
                            result["timedOut"] = error.is_timeout().into();
                            result["bodyError"] = error.without_url().to_string().into();
                            break;
                        }
                    }
                }
            }
        }
        Err(error) => {
            result["timedOut"] = error.is_timeout().into();
            result["connectError"] = error.is_connect().into();
            result["error"] = error
                .without_url()
                .to_string()
                .chars()
                .take(1000)
                .collect::<String>()
                .into();
        }
    }
    result["elapsedMs"] = serde_json::json!(started.elapsed().as_millis());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

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

    fn response_fixture(
        status: u16,
        headers: &str,
        stall: Option<Duration>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind diagnostic fixture");
        let url = format!("http://{}", listener.local_addr().unwrap());
        let headers = headers.to_owned();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = String::new();
                loop {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0] as char);
                    if request.ends_with("\r\n\r\n") {
                        break;
                    }
                }
                requests.push(request);
                if let Some(delay) = stall {
                    thread::sleep(delay);
                }
                // Only `ok` is retained; neither the health nor the chain body is persisted.
                let body = r#"{"ok":true,"private":"excluded-body"}"#;
                let written = write!(
                    stream,
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
                    body.len()
                );
                if stall.is_none() {
                    written.unwrap();
                }
            }
            requests
        });
        (url, handle)
    }

    #[test]
    fn native_comparison_records_status_and_cors_with_the_actual_frontend_origin() {
        let (url, handle) = response_fixture(
            200,
            "Access-Control-Allow-Origin: tauri://localhost\r\nAccess-Control-Allow-Credentials: true\r\n",
            None,
        );
        let origin = DiagnosticValue::String("tauri://localhost".into());
        let result = tauri::async_runtime::block_on(compare_backend(&url, Some(&origin)));
        assert_eq!(result["health"]["runtimeHealthOk"], true);
        assert_eq!(result["defaultChain"]["httpStatus"], 200);
        assert_eq!(result["defaultChain"]["allowOrigin"], "tauri://localhost");
        assert_eq!(result["defaultChain"]["allowCredentials"], "true");
        assert!(!result.to_string().contains("excluded-body"));
        let requests = handle.join().unwrap();
        assert!(requests.iter().all(|request| {
            request
                .to_lowercase()
                .contains("origin: tauri://localhost\r\n")
        }));
        for path in [
            &runtime_api_routes().health,
            &runtime_api_routes().default_chain,
        ] {
            assert!(
                requests
                    .iter()
                    .any(|request| request.starts_with(&format!("GET {path} HTTP/1.1")))
            );
        }
    }

    #[test]
    fn native_comparison_exposes_missing_cors_and_never_follows_redirects() {
        let (url, handle) =
            response_fixture(302, "Location: https://outside.example.invalid/\r\n", None);
        let result = tauri::async_runtime::block_on(compare_backend(&url, None));
        assert_eq!(result["defaultChain"]["httpStatus"], 302);
        assert_eq!(result["defaultChain"]["allowOrigin"], "");
        assert_eq!(result["redirectsFollowed"], false);
        assert_eq!(handle.join().unwrap().len(), 2);
    }

    #[test]
    fn native_comparison_refuses_non_loopback_targets_and_reports_connection_failure() {
        let result =
            tauri::async_runtime::block_on(compare_backend("http://outside.example.invalid", None));
        assert_eq!(result["skipped"], "backend-url-is-not-local-infra");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let result = tauri::async_runtime::block_on(compare_backend(&url, None));
        assert_eq!(result["health"]["connectError"], true);
        assert_eq!(result["defaultChain"]["connectError"], true);
    }

    #[test]
    fn native_comparison_times_out_both_requests_without_waiting_for_the_fixture() {
        let (url, handle) = response_fixture(
            200,
            "",
            Some(COMPARISON_TIMEOUT + Duration::from_millis(200)),
        );
        let started = Instant::now();
        let result = tauri::async_runtime::block_on(compare_backend(&url, None));
        assert_eq!(result["health"]["timedOut"], true);
        assert_eq!(result["defaultChain"]["timedOut"], true);
        assert!(started.elapsed() < COMPARISON_TIMEOUT * 2);
        handle.join().unwrap();
    }
}
