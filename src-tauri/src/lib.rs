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
            if let Err(error) = state.runtime.auto_start(app.handle().clone()) {
                log::error!("Desktop runtime auto-start failed: {error}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<DesktopState>();
                if let Err(error) = state.runtime.stop(window.app_handle().clone()) {
                    log::error!("Desktop runtime shutdown on close failed: {error}");
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
            }
        }
    });
}
