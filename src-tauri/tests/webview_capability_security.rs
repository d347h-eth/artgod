use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindowBuilder, ipc::InvokeBody};

// These Tauri plugin commands must remain unavailable to every WebView.
const SHELL_SPAWN_COMMAND: &str = "plugin:shell|spawn";
const SHELL_STDIN_WRITE_COMMAND: &str = "plugin:shell|stdin_write";

#[test]
fn main_webview_cannot_invoke_shell_process_commands() {
    let app = mock_builder()
        .plugin(tauri_plugin_shell::init())
        .build(tauri::generate_context!())
        .expect("mock Tauri app should build");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main mock WebView should build");
    let local_tauri_url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };

    for command in [SHELL_SPAWN_COMMAND, SHELL_STDIN_WRITE_COMMAND] {
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: command.to_owned(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: local_tauri_url
                    .parse()
                    .expect("local Tauri URL should parse"),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_owned(),
            },
        );

        let error = response.expect_err("shell process IPC should be denied");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed")),
            "unexpected ACL response for {command}: {error}",
        );
    }
}
