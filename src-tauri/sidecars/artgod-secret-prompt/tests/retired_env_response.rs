use std::process::{Command, Stdio};

use artgod_secret_prompt_protocol::{
    SecretPromptAction, SecretPromptErrorCode, SecretPromptResponse, UnlockSecretPromptResponse,
};

const RETIRED_TEST_MODE_ENV_KEY: &str = "ARTGOD_SECRET_PROMPT_TEST_MODE";
const RETIRED_TEST_RESPONSE_ENV_KEY: &str = "ARTGOD_SECRET_PROMPT_TEST_RESPONSE";

#[test]
fn retired_environment_inputs_cannot_submit_a_prompt_response() {
    let injected_response = SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
        passphrase: "environment-injected-passphrase".to_owned(),
    });
    let output = Command::new(env!("CARGO_BIN_EXE_artgod-secret-prompt"))
        .args(["--action", SecretPromptAction::Unlock.as_cli_arg()])
        .env(RETIRED_TEST_MODE_ENV_KEY, "1")
        .env(
            RETIRED_TEST_RESPONSE_ENV_KEY,
            serde_json::to_string(&injected_response).expect("test response serializes"),
        )
        .stdin(Stdio::null())
        .output()
        .expect("secret prompt helper starts");

    assert!(!output.status.success());
    let response: SecretPromptResponse =
        serde_json::from_slice(&output.stdout).expect("helper emits one protocol response");
    let SecretPromptResponse::Error(error) = response else {
        panic!("closed stdin must reject the injected response: {response:?}");
    };
    assert_eq!(error.action, SecretPromptAction::Unlock);
    assert_eq!(error.code, SecretPromptErrorCode::InvalidRequest);
}
