use std::process::{Command, Stdio};

use artgod_secret_prompt_protocol::{
    SecretPromptAction, SecretPromptResponse, UnlockSecretPromptResponse,
};
use zeroize::Zeroizing;

const RETIRED_TEST_MODE_ENV_KEY: &str = "ARTGOD_SECRET_PROMPT_TEST_MODE";
const RETIRED_TEST_RESPONSE_ENV_KEY: &str = "ARTGOD_SECRET_PROMPT_TEST_RESPONSE";

#[test]
fn retired_environment_inputs_cannot_submit_a_prompt_response() {
    let injected_response = SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
        passphrase: Zeroizing::new("environment-injected-passphrase".to_owned()),
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
    assert!(
        output.stdout.is_empty(),
        "owner loss before request must not emit a protocol response"
    );
}
