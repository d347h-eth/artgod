use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindowBuilder, ipc::InvokeBody};

// Upstream wire vocabulary is private; assert it at the IPC boundary.
const CHANNEL_FETCH_COMMAND: &str = "plugin:__TAURI_CHANNEL__|fetch";
const CHANNEL_ID_HEADER: &str = "Tauri-Channel-Id";

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

#[test]
fn a_foreign_webview_cannot_read_or_drain_a_pending_channel_response() {
    use std::str::FromStr;
    use tauri::ipc::JavaScriptChannelId;

    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock Tauri app should build");
    let owner = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let foreign = WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .unwrap();
    let secret = "private channel response".repeat(1024);
    let owner_webview: &tauri::Webview<tauri::test::MockRuntime> = owner.as_ref();
    let channel = JavaScriptChannelId::from_str("__CHANNEL__:42")
        .unwrap()
        .channel_on::<_, String>(owner_webview.clone());
    channel.send(secret.clone()).unwrap();

    // Tauri 2.11.6 starts each fresh WebView queue at zero. Use the same real
    // pending ID from both callers, then prove the owner's response survived.
    let fetch = |webview: &tauri::WebviewWindow<tauri::test::MockRuntime>| {
        let mut request = InvokeRequest {
            cmd: CHANNEL_FETCH_COMMAND.to_owned(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_owned(),
        };
        request
            .headers
            .insert(CHANNEL_ID_HEADER, "0".parse().unwrap());
        get_ipc_response(webview, request)
    };
    let error = fetch(&foreign).expect_err("a foreign WebView must not read the owner's response");
    assert_eq!(error.as_str(), Some("data not found"));
    let response = fetch(&owner).expect("the owner's pending data must remain available");
    assert_eq!(response.deserialize::<String>().unwrap(), secret);
    assert_eq!(fetch(&owner).unwrap_err().as_str(), Some("data not found"));
}
