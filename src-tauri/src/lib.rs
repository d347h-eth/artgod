mod runtime;

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
    tauri::Builder::default()
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
            if let Err(error) = state.runtime.auto_start(app.handle().clone()) {
                log::error!("Desktop runtime auto-start failed: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_start,
            runtime_stop,
            runtime_status,
            runtime_get_endpoints,
            runtime_get_config_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
