mod runtime;

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use runtime::{DesktopRuntimeConfig, RuntimeEndpoints, RuntimeManager, RuntimeStatus};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use time::OffsetDateTime;

struct DesktopState {
    runtime: RuntimeManager,
    shutdown_requested: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePreflight {
    ok: bool,
    checks: Vec<RuntimePreflightCheck>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePreflightCheck {
    key: String,
    status: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLogLine {
    process: String,
    line: String,
}

#[tauri::command]
fn runtime_start(app: AppHandle, state: State<'_, DesktopState>) -> Result<RuntimeStatus, String> {
    state.runtime.start(app)
}

#[tauri::command]
fn runtime_stop(app: AppHandle, state: State<'_, DesktopState>) -> Result<RuntimeStatus, String> {
    state.runtime.stop(app)
}

#[tauri::command]
fn runtime_status(state: State<'_, DesktopState>) -> Result<RuntimeStatus, String> {
    state.runtime.status()
}

#[tauri::command]
fn runtime_restart(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<RuntimeStatus, String> {
    state.runtime.stop(app.clone())?;
    state.runtime.start(app)
}

#[tauri::command]
fn runtime_get_endpoints(state: State<'_, DesktopState>) -> Result<RuntimeEndpoints, String> {
    state.runtime.endpoints()
}

#[tauri::command]
fn runtime_get_config_path(state: State<'_, DesktopState>) -> Result<String, String> {
    state.runtime.config_path()
}

#[tauri::command]
fn runtime_get_logs_path(app: AppHandle) -> Result<String, String> {
    Ok(resolve_logs_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn runtime_open_config_path(state: State<'_, DesktopState>) -> Result<(), String> {
    let path = state.runtime.config_path()?;
    open_path(Path::new(&path))
}

#[tauri::command]
fn runtime_open_logs_path(app: AppHandle) -> Result<(), String> {
    let logs_dir = resolve_logs_dir(&app)?;
    open_path(&logs_dir)
}

#[tauri::command]
fn runtime_get_logs_tail(
    app: AppHandle,
    process: Option<String>,
    limit_per_process: Option<usize>,
) -> Result<Vec<RuntimeLogLine>, String> {
    let logs_dir = resolve_logs_dir(&app)?;
    let limit = limit_per_process.unwrap_or(120).clamp(1, 1000);
    if let Some(process_name) = process {
        return collect_process_logs_tail(&logs_dir, &process_name, limit);
    }
    collect_logs_tail(&logs_dir, limit)
}

#[tauri::command]
fn runtime_preflight(app: AppHandle, state: State<'_, DesktopState>) -> RuntimePreflight {
    let mut checks = Vec::<RuntimePreflightCheck>::new();
    let runtime_status = state.runtime.status().ok();
    let runtime_running = runtime_status
        .as_ref()
        .map(|snapshot| snapshot.state == "starting" || snapshot.state == "running")
        .unwrap_or(false);

    let config = match DesktopRuntimeConfig::load_or_create(&app) {
        Ok(config) => {
            checks.push(RuntimePreflightCheck {
                key: "desktopConfig".to_owned(),
                status: "pass".to_owned(),
                message: "Desktop config is readable".to_owned(),
            });
            config
        }
        Err(error) => {
            checks.push(RuntimePreflightCheck {
                key: "desktopConfig".to_owned(),
                status: "fail".to_owned(),
                message: format!("Desktop config invalid: {error}"),
            });
            return RuntimePreflight { ok: false, checks };
        }
    };

    push_exists_check(
        &mut checks,
        "runtimeResources",
        "Runtime resources directory",
        &config.runtime_dir,
    );
    push_exists_check(
        &mut checks,
        "nodeBinary",
        "Bundled Node binary",
        &config.node_bin,
    );
    push_exists_check(
        &mut checks,
        "natsBinary",
        "Bundled NATS binary",
        &config.nats_bin,
    );
    push_exists_check(
        &mut checks,
        "pnpCjs",
        "Yarn PnP .pnp.cjs",
        &config.pnp_cjs_path,
    );
    push_exists_check(
        &mut checks,
        "pnpLoader",
        "Yarn PnP .pnp.loader.mjs",
        &config.pnp_loader_path,
    );

    push_env_check(&mut checks, &config, "ARTGOD_DB_PATH");
    push_env_check(&mut checks, &config, "RPC_URL");
    push_env_check(&mut checks, &config, "WETH_ADDRESS");
    push_env_check(&mut checks, &config, "SEAPORT_CONDUIT_CONTROLLER");

    push_port_check(
        &mut checks,
        "natsPort",
        config.nats_port,
        runtime_running,
        "NATS port",
    );
    push_port_check(
        &mut checks,
        "backendPort",
        config.backend_port,
        runtime_running,
        "Backend port",
    );

    let writable_probe = match app.path().app_data_dir() {
        Ok(path) => path.join(".runtime-preflight-write-probe"),
        Err(error) => {
            checks.push(RuntimePreflightCheck {
                key: "appDataWritable".to_owned(),
                status: "fail".to_owned(),
                message: format!("Failed to resolve app-data dir: {error}"),
            });
            return RuntimePreflight {
                ok: checks.iter().all(|check| check.status != "fail"),
                checks,
            };
        }
    };
    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&writable_probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&writable_probe);
            checks.push(RuntimePreflightCheck {
                key: "appDataWritable".to_owned(),
                status: "pass".to_owned(),
                message: "App-data directory is writable".to_owned(),
            });
        }
        Err(error) => checks.push(RuntimePreflightCheck {
            key: "appDataWritable".to_owned(),
            status: "fail".to_owned(),
            message: format!("App-data directory is not writable: {error}"),
        }),
    }

    RuntimePreflight {
        ok: checks.iter().all(|check| check.status != "fail"),
        checks,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(DesktopState {
            runtime: RuntimeManager::new(),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let state = app.state::<DesktopState>();
            append_desktop_log(app.handle(), "info", "Desktop app setup started");
            if let Err(error) = state.runtime.auto_start(app.handle().clone()) {
                log::error!("Desktop runtime auto-start failed: {error}");
                append_desktop_log(
                    app.handle(),
                    "error",
                    &format!("Desktop runtime auto-start failed: {error}"),
                );
            } else {
                append_desktop_log(app.handle(), "info", "Desktop runtime auto-start finished");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();

                let state = window.state::<DesktopState>();
                if state.shutdown_requested.swap(true, Ordering::SeqCst) {
                    return;
                }

                let app_handle = window.app_handle().clone();
                append_desktop_log(
                    &app_handle,
                    "info",
                    "Window close requested; stopping runtime before app exit",
                );

                std::thread::spawn(move || {
                    let state = app_handle.state::<DesktopState>();
                    if let Err(error) = state.runtime.stop(app_handle.clone()) {
                        log::error!("Desktop runtime shutdown on close failed: {error}");
                        append_desktop_log(
                            &app_handle,
                            "error",
                            &format!("Desktop runtime shutdown on close failed: {error}"),
                        );
                    } else {
                        append_desktop_log(
                            &app_handle,
                            "info",
                            "Runtime stopped after window close request",
                        );
                    }
                    app_handle.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_start,
            runtime_stop,
            runtime_restart,
            runtime_status,
            runtime_get_endpoints,
            runtime_get_config_path,
            runtime_get_logs_path,
            runtime_open_config_path,
            runtime_open_logs_path,
            runtime_get_logs_tail,
            runtime_preflight
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<DesktopState>();
            if state.shutdown_requested.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Err(error) = state.runtime.stop(app_handle.clone()) {
                log::error!("Desktop runtime shutdown on exit failed: {error}");
                append_desktop_log(
                    app_handle,
                    "error",
                    &format!("Desktop runtime shutdown on exit failed: {error}"),
                );
            }
        }
    });
}

fn append_desktop_log(app: &AppHandle, level: &str, message: &str) {
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

fn resolve_logs_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
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
    Ok(logs_dir)
}

fn collect_logs_tail(logs_dir: &Path, limit: usize) -> Result<Vec<RuntimeLogLine>, String> {
    let mut entries = fs::read_dir(logs_dir)
        .map_err(|error| {
            format!(
                "Failed to read logs directory {}: {error}",
                logs_dir.display()
            )
        })?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("log"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut result = Vec::<RuntimeLogLine>::new();
    for entry in entries {
        let path = entry.path();
        let process = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .unwrap_or_else(|| "unknown".to_owned());
        let tail = read_file_tail_lines(&path, limit);
        for line in tail {
            result.push(RuntimeLogLine {
                process: process.clone(),
                line,
            });
        }
    }
    Ok(result)
}

fn collect_process_logs_tail(
    logs_dir: &Path,
    process: &str,
    limit: usize,
) -> Result<Vec<RuntimeLogLine>, String> {
    let mut entries = fs::read_dir(logs_dir)
        .map_err(|error| {
            format!(
                "Failed to read logs directory {}: {error}",
                logs_dir.display()
            )
        })?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("log"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let process_name = path.file_stem().and_then(|stem| stem.to_str());
        if process_name != Some(process) {
            continue;
        }
        let tail = read_file_tail_lines(&path, limit);
        let result = tail
            .into_iter()
            .map(|line| RuntimeLogLine {
                process: process.to_owned(),
                line,
            })
            .collect::<Vec<_>>();
        return Ok(result);
    }

    Ok(Vec::new())
}

fn read_file_tail_lines(path: &Path, limit: usize) -> Vec<String> {
    let file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let mut tail = VecDeque::<String>::new();
    for line in reader.lines().map_while(Result::ok) {
        if tail.len() >= limit {
            let _ = tail.pop_front();
        }
        tail.push_back(line);
    }
    tail.into_iter().collect::<Vec<_>>()
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

fn push_exists_check(checks: &mut Vec<RuntimePreflightCheck>, key: &str, label: &str, path: &Path) {
    if path.exists() {
        checks.push(RuntimePreflightCheck {
            key: key.to_owned(),
            status: "pass".to_owned(),
            message: format!("{label} exists at {}", path.display()),
        });
    } else {
        checks.push(RuntimePreflightCheck {
            key: key.to_owned(),
            status: "fail".to_owned(),
            message: format!("{label} missing at {}", path.display()),
        });
    }
}

fn push_env_check(
    checks: &mut Vec<RuntimePreflightCheck>,
    config: &DesktopRuntimeConfig,
    key: &str,
) {
    let value = config
        .process_env
        .get(key)
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() {
        checks.push(RuntimePreflightCheck {
            key: key.to_owned(),
            status: "fail".to_owned(),
            message: format!("{key} is missing"),
        });
    } else {
        checks.push(RuntimePreflightCheck {
            key: key.to_owned(),
            status: "pass".to_owned(),
            message: format!("{key} configured"),
        });
    }
}

fn push_port_check(
    checks: &mut Vec<RuntimePreflightCheck>,
    key: &str,
    port: u16,
    runtime_running: bool,
    label: &str,
) {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            checks.push(RuntimePreflightCheck {
                key: key.to_owned(),
                status: "pass".to_owned(),
                message: format!("{label} {port} is available"),
            });
        }
        Err(error) => {
            if runtime_running {
                checks.push(RuntimePreflightCheck {
                    key: key.to_owned(),
                    status: "warn".to_owned(),
                    message: format!(
                        "{label} {port} is already in use (expected while runtime is running): {error}"
                    ),
                });
            } else {
                checks.push(RuntimePreflightCheck {
                    key: key.to_owned(),
                    status: "fail".to_owned(),
                    message: format!("{label} {port} is not available: {error}"),
                });
            }
        }
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    Ok(())
}
