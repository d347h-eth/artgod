mod desktop_log;
mod runtime;
mod wallet;

use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::desktop_log::{
    append_desktop_log, cleanup_desktop_logs_for_app, log_file_belongs_to_process,
    process_name_for_log_file, start_desktop_log_maintenance,
};
use runtime::{
    AppConfigState, DesktopRuntimeConfig, RPC_ENDPOINT_LIST_ENV_KEY, RpcEndpointBenchmarkInput,
    RpcEndpointBenchmarkResult, RuntimeEndpoints, RuntimeManager, RuntimeStatus,
    SaveAppConfigInput, benchmark_rpc_endpoints, ensure_desktop_config_paths,
    load_app_config_state, save_app_config, use_default_app_config,
};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, include_image};
use wallet::tauri::{
    BotCommandState, WalletCommandState, bot_assign_wallet, bot_list, bot_start, bot_stop,
    wallet_export, wallet_get_status, wallet_import, wallet_list, wallet_remove,
};

pub(crate) struct DesktopState {
    pub(crate) runtime: RuntimeManager,
    pub(crate) shutdown_requested: Arc<AtomicBool>,
}

const TRAY_OPEN_USERLAND_ID: &str = "tray.open_userland";
const TRAY_OPEN_ADMIN_ID: &str = "tray.open_admin";
const TRAY_SHUTDOWN_ID: &str = "tray.shutdown";
const ADMIN_SHUTDOWN_REQUEST_REASON: &str = "admin shutdown requested";
const TRAY_SHUTDOWN_REQUEST_REASON: &str = "tray shutdown requested";
const TRAY_ICON: tauri::image::Image<'_> = include_image!("./icons/tray_icon.png");

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
fn runtime_auto_start(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<RuntimeStatus, String> {
    state.runtime.auto_start(app)?;
    state.runtime.status()
}

#[tauri::command]
async fn runtime_stop(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<RuntimeStatus, String> {
    let runtime = state.runtime.clone();
    run_blocking_runtime_command(move || runtime.stop(app)).await
}

#[tauri::command]
fn runtime_shutdown(app: AppHandle) -> Result<(), String> {
    request_runtime_shutdown(&app, ADMIN_SHUTDOWN_REQUEST_REASON);
    Ok(())
}

#[tauri::command]
fn runtime_status(state: State<'_, DesktopState>) -> Result<RuntimeStatus, String> {
    state.runtime.status()
}

#[tauri::command]
async fn runtime_restart(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<RuntimeStatus, String> {
    let runtime = state.runtime.clone();
    run_blocking_runtime_command(move || runtime.restart(app)).await
}

#[tauri::command]
fn runtime_get_endpoints(state: State<'_, DesktopState>) -> Result<RuntimeEndpoints, String> {
    state.runtime.endpoints()
}

#[tauri::command]
fn runtime_get_config_path(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    match state.runtime.config_path() {
        Ok(path) => Ok(path),
        Err(_) => Ok(ensure_desktop_config_paths(&app)?
            .env_file_path
            .to_string_lossy()
            .into_owned()),
    }
}

#[tauri::command]
fn runtime_get_logs_path(app: AppHandle) -> Result<String, String> {
    Ok(resolve_logs_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn runtime_open_config_path(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    let path = match state.runtime.config_path() {
        Ok(path) => Path::new(&path).to_path_buf(),
        Err(_) => ensure_desktop_config_paths(&app)?.env_file_path,
    };
    open_path(&path)
}

#[tauri::command]
fn runtime_open_logs_path(app: AppHandle) -> Result<(), String> {
    let logs_dir = resolve_logs_dir(&app)?;
    open_path(&logs_dir)
}

#[tauri::command]
fn runtime_open_userland_ui(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    let url = resolve_userland_ui_url(&app, &state)?;
    open_url(&url)
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
fn runtime_list_log_processes(app: AppHandle) -> Result<Vec<String>, String> {
    let logs_dir = resolve_logs_dir(&app)?;
    list_log_processes(&logs_dir)
}

#[tauri::command]
fn app_config_get(app: AppHandle) -> Result<AppConfigState, String> {
    load_app_config_state(&app)
}

#[tauri::command]
fn app_config_save(app: AppHandle, input: SaveAppConfigInput) -> Result<AppConfigState, String> {
    let state = save_app_config(&app, input)?;
    cleanup_desktop_logs_after_config_change(&app);
    Ok(state)
}

#[tauri::command]
fn app_config_use_defaults(app: AppHandle) -> Result<AppConfigState, String> {
    let state = use_default_app_config(&app)?;
    cleanup_desktop_logs_after_config_change(&app);
    Ok(state)
}

#[tauri::command]
async fn app_config_benchmark_rpc_endpoints(
    app: AppHandle,
    input: RpcEndpointBenchmarkInput,
) -> Result<RpcEndpointBenchmarkResult, String> {
    benchmark_rpc_endpoints(&app, input).await
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
    push_env_check(&mut checks, &config, "USERLAND_UI_DIST_DIR");
    push_env_check(&mut checks, &config, RPC_ENDPOINT_LIST_ENV_KEY);
    push_env_check(&mut checks, &config, "RPC_RATE_LIMIT_REQUESTS_PER_SECOND");
    push_env_check(&mut checks, &config, "RPC_RATE_LIMIT_BURST");
    push_env_check(&mut checks, &config, "WETH_ADDRESS");
    push_env_check(&mut checks, &config, "SEAPORT_CONDUIT_CONTROLLER");
    push_opensea_integration_check(
        &mut checks,
        config.capabilities.opensea.enabled,
        config.capabilities.opensea.reason.as_deref(),
    );
    if let Some(userland_dist) = config.process_env.get("USERLAND_UI_DIST_DIR") {
        push_exists_check(
            &mut checks,
            "userlandUiDistDir",
            "Userland frontend static artifacts",
            Path::new(userland_dist),
        );
    }

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

async fn run_blocking_runtime_command<F>(command: F) -> Result<RuntimeStatus, String>
where
    F: FnOnce() -> Result<RuntimeStatus, String> + Send + 'static,
{
    // Runtime stop/restart joins child-process supervisor threads; keep it off Tauri's IPC thread.
    tauri::async_runtime::spawn_blocking(command)
        .await
        .map_err(|error| format!("Runtime command task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(DesktopState {
            runtime: RuntimeManager::new(),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
        })
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let wallet_state =
                WalletCommandState::load(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(wallet_state);
            let bot_state = BotCommandState::load(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(bot_state);

            ensure_desktop_config_paths(app.handle()).map_err(std::io::Error::other)?;
            start_desktop_log_maintenance(app.handle().clone());
            append_desktop_log(app.handle(), "info", "Desktop app setup started");
            append_desktop_log(
                app.handle(),
                "info",
                "Desktop runtime auto-start is deferred until frontend handshake",
            );

            let open_userland = MenuItem::with_id(
                app.handle(),
                TRAY_OPEN_USERLAND_ID,
                "Open ArtGod in browser",
                true,
                None::<&str>,
            )?;
            let open_admin = MenuItem::with_id(
                app.handle(),
                TRAY_OPEN_ADMIN_ID,
                "Open Admin UI",
                true,
                None::<&str>,
            )?;
            let shutdown = MenuItem::with_id(
                app.handle(),
                TRAY_SHUTDOWN_ID,
                "Shutdown",
                true,
                None::<&str>,
            )?;
            let tray_menu =
                Menu::with_items(app.handle(), &[&open_userland, &open_admin, &shutdown])?;

            TrayIconBuilder::new()
                .icon(TRAY_ICON)
                .tooltip("ArtGod")
                .menu(&tray_menu)
                .on_menu_event(|app_handle: &AppHandle, event| {
                    let menu_id = event.id.as_ref();
                    match menu_id {
                        TRAY_OPEN_USERLAND_ID => {
                            open_userland_ui(app_handle);
                        }
                        TRAY_OPEN_ADMIN_ID => {
                            show_admin_window(app_handle);
                        }
                        TRAY_SHUTDOWN_ID => {
                            request_runtime_shutdown(app_handle, TRAY_SHUTDOWN_REQUEST_REASON);
                        }
                        _ => {}
                    }
                })
                .build(app.handle())?;

            Ok(())
        })
        .on_tray_icon_event(|app_handle, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                open_userland_ui(app_handle);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    append_desktop_log(
                        &window.app_handle(),
                        "error",
                        &format!("Failed to hide admin window on close request: {error}"),
                    );
                } else {
                    append_desktop_log(
                        &window.app_handle(),
                        "info",
                        "Admin window hidden (runtime remains active in tray)",
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_auto_start,
            runtime_start,
            runtime_stop,
            runtime_shutdown,
            runtime_restart,
            runtime_status,
            runtime_get_endpoints,
            runtime_get_config_path,
            runtime_get_logs_path,
            runtime_open_config_path,
            runtime_open_logs_path,
            runtime_open_userland_ui,
            runtime_get_logs_tail,
            runtime_list_log_processes,
            runtime_preflight,
            app_config_get,
            app_config_save,
            app_config_use_defaults,
            app_config_benchmark_rpc_endpoints,
            wallet_list,
            wallet_get_status,
            wallet_import,
            wallet_export,
            wallet_remove,
            bot_list,
            bot_assign_wallet,
            bot_start,
            bot_stop
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

fn request_runtime_shutdown(app_handle: &AppHandle, reason: &str) {
    let state = app_handle.state::<DesktopState>();
    if state.shutdown_requested.swap(true, Ordering::SeqCst) {
        return;
    }

    append_desktop_log(app_handle, "info", reason);
    let app_handle = app_handle.clone();
    std::thread::spawn(move || {
        let state = app_handle.state::<DesktopState>();
        if let Err(error) = state.runtime.stop(app_handle.clone()) {
            log::error!("Desktop runtime shutdown failed: {error}");
            append_desktop_log(
                &app_handle,
                "error",
                &format!("Desktop runtime shutdown failed: {error}"),
            );
        } else {
            append_desktop_log(
                &app_handle,
                "info",
                "Runtime stopped after shutdown request",
            );
        }
        app_handle.exit(0);
    });
}

fn show_admin_window(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        append_desktop_log(
            app_handle,
            "error",
            "Failed to open admin window: main window not found",
        );
        return;
    };
    if let Err(error) = window.show() {
        append_desktop_log(
            app_handle,
            "error",
            &format!("Failed to show admin window: {error}"),
        );
        return;
    }
    if let Err(error) = window.set_focus() {
        append_desktop_log(
            app_handle,
            "warn",
            &format!("Admin window shown but focus failed: {error}"),
        );
    }
}

fn open_userland_ui(app_handle: &AppHandle) {
    let state = app_handle.state::<DesktopState>();
    match resolve_userland_ui_url(app_handle, &state) {
        Ok(url) => {
            if let Err(error) = open_url(&url) {
                append_desktop_log(
                    app_handle,
                    "error",
                    &format!("Failed to open userland UI: {error}"),
                );
            }
        }
        Err(error) => append_desktop_log(
            app_handle,
            "error",
            &format!("Failed to resolve userland UI URL: {error}"),
        ),
    }
}

fn resolve_userland_ui_url(app: &AppHandle, state: &DesktopState) -> Result<String, String> {
    if let Ok(endpoints) = state.runtime.endpoints() {
        let url = endpoints.backend_http_base_url.trim();
        if !url.is_empty() {
            return Ok(url.to_owned());
        }
    }

    let config = DesktopRuntimeConfig::load_or_create(app)?;
    Ok(config.backend_http_base_url())
}

fn resolve_logs_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let paths = ensure_desktop_config_paths(app)?;
    Ok(paths.logs_dir)
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
        .filter(|entry| process_name_for_log_file(&entry.path()).is_some())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut tails = BTreeMap::<String, VecDeque<String>>::new();
    for entry in entries {
        let path = entry.path();
        let Some(process) = process_name_for_log_file(&path) else {
            continue;
        };
        let process_tail = tails.entry(process).or_default();
        for line in read_file_tail_lines(&path, limit) {
            if process_tail.len() >= limit {
                let _ = process_tail.pop_front();
            }
            process_tail.push_back(line);
        }
    }
    Ok(tails
        .into_iter()
        .flat_map(|(process, tail)| {
            tail.into_iter().map(move |line| RuntimeLogLine {
                process: process.clone(),
                line,
            })
        })
        .collect::<Vec<_>>())
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
        .filter(|entry| log_file_belongs_to_process(&entry.path(), process))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut tail = VecDeque::<String>::new();
    for entry in entries {
        let path = entry.path();
        for line in read_file_tail_lines(&path, limit) {
            if tail.len() >= limit {
                let _ = tail.pop_front();
            }
            tail.push_back(line);
        }
    }

    Ok(tail
        .into_iter()
        .map(|line| RuntimeLogLine {
            process: process.to_owned(),
            line,
        })
        .collect::<Vec<_>>())
}

fn list_log_processes(logs_dir: &Path) -> Result<Vec<String>, String> {
    let mut entries = fs::read_dir(logs_dir)
        .map_err(|error| {
            format!(
                "Failed to read logs directory {}: {error}",
                logs_dir.display()
            )
        })?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| process_name_for_log_file(&entry.path()))
        .collect::<Vec<_>>();
    entries.sort();
    entries.dedup();
    Ok(entries)
}

fn cleanup_desktop_logs_after_config_change(app: &AppHandle) {
    if let Err(error) = cleanup_desktop_logs_for_app(app) {
        append_desktop_log(
            app,
            "warn",
            &format!("Desktop log cleanup after config change failed: {error}"),
        );
    }
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

fn push_opensea_integration_check(
    checks: &mut Vec<RuntimePreflightCheck>,
    enabled: bool,
    reason: Option<&str>,
) {
    if enabled {
        checks.push(RuntimePreflightCheck {
            key: "openseaIntegration".to_owned(),
            status: "pass".to_owned(),
            message: "OpenSea integration enabled".to_owned(),
        });
    } else {
        checks.push(RuntimePreflightCheck {
            key: "openseaIntegration".to_owned(),
            status: "warn".to_owned(),
            message: reason.unwrap_or("OpenSea integration disabled").to_owned(),
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

fn open_url(url: &str) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("Failed to open URL {url}: {error}"))?;
    Ok(())
}
