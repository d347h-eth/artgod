mod runtime;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use runtime::{RuntimeEndpoints, RuntimeManager, RuntimeStatus};
use tauri::{AppHandle, Manager, State};

struct DesktopState {
    runtime: RuntimeManager,
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
fn runtime_get_endpoints(state: State<'_, DesktopState>) -> Result<RuntimeEndpoints, String> {
    state.runtime.endpoints()
}

#[tauri::command]
fn runtime_get_config_path(state: State<'_, DesktopState>) -> Result<String, String> {
    state.runtime.config_path()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(DesktopState {
            runtime: RuntimeManager::new(),
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
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<DesktopState>();
                if let Err(error) = state.runtime.stop(window.app_handle().clone()) {
                    log::error!("Desktop runtime shutdown on close failed: {error}");
                    append_desktop_log(
                        &window.app_handle(),
                        "error",
                        &format!("Desktop runtime shutdown on close failed: {error}"),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_start,
            runtime_stop,
            runtime_status,
            runtime_get_endpoints,
            runtime_get_config_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<DesktopState>();
            if let Err(error) = state.runtime.stop(app_handle.clone()) {
                log::error!("Desktop runtime shutdown on exit failed: {error}");
                append_desktop_log(
                    &app_handle,
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
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{}] [{}] {}", timestamp, level, message);
}
