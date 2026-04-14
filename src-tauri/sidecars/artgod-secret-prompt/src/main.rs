mod generated_font;
mod prompt_ui;

use std::env;
use std::io::{self, BufRead, Write};

use artgod_secret_prompt_protocol::{
    CancelledSecretPromptResponse, ErrorSecretPromptResponse, ExportConfirmSecretPromptRequest,
    ExportConfirmSecretPromptResponse, ExportRevealAcknowledgedResponse,
    ExportRevealSecretPromptRequest, ImportSecretPromptRequest, ImportSecretPromptResponse,
    RemoveConfirmSecretPromptRequest, RemoveConfirmSecretPromptResponse, SecretPromptAction,
    SecretPromptErrorCode, SecretPromptRequest, SecretPromptResponse, UnlockSecretPromptRequest,
    UnlockSecretPromptResponse,
};
use prompt_ui::{
    ExportConfirmPromptSpec, ImportPromptSpec, RemoveConfirmPromptSpec, RevealPromptSpec,
    TextInputKind, TextPromptMode, TextPromptSpec, TextValidationSpec,
};
use thiserror::Error;

fn main() {
    let exit_code = match run() {
        Ok(()) => 0,
        Err(error) => {
            let action = error.action().unwrap_or(SecretPromptAction::Unlock);
            let response = SecretPromptResponse::Error(ErrorSecretPromptResponse {
                action,
                code: error.code(),
                message: error.public_message(),
            });
            let _ = write_response(&response);
            1
        }
    };
    std::process::exit(exit_code);
}

fn run() -> Result<(), SecretPromptHelperError> {
    let action = read_action_from_args()?;
    let request = if let Some(response) = try_test_mode_response(action)? {
        write_response(&response)?;
        return Ok(());
    } else {
        read_request(action)?
    };

    if request.action() != action {
        return Err(SecretPromptHelperError::ActionMismatch {
            expected: action,
            actual: request.action(),
        });
    }

    let response = handle_request(request)?;
    write_response(&response)?;
    Ok(())
}

fn read_action_from_args() -> Result<SecretPromptAction, SecretPromptHelperError> {
    let mut args = env::args().skip(1);
    let Some(flag) = args.next() else {
        return Err(SecretPromptHelperError::InvalidRequest(
            "Missing --action argument".to_owned(),
        ));
    };
    if flag != "--action" {
        return Err(SecretPromptHelperError::InvalidRequest(format!(
            "Unexpected argument: {flag}"
        )));
    }
    let Some(raw_action) = args.next() else {
        return Err(SecretPromptHelperError::InvalidRequest(
            "Missing action value".to_owned(),
        ));
    };
    SecretPromptAction::parse_cli_arg(&raw_action).ok_or_else(|| {
        SecretPromptHelperError::InvalidRequest(format!("Unsupported action: {raw_action}"))
    })
}

fn try_test_mode_response(
    action: SecretPromptAction,
) -> Result<Option<SecretPromptResponse>, SecretPromptHelperError> {
    let enabled = env::var("ARTGOD_SECRET_PROMPT_TEST_MODE")
        .ok()
        .map(|value| value == "1")
        .unwrap_or(false);
    if !enabled {
        return Ok(None);
    }

    let raw_response = env::var("ARTGOD_SECRET_PROMPT_TEST_RESPONSE").map_err(|_| {
        SecretPromptHelperError::InvalidRequest(
            "ARTGOD_SECRET_PROMPT_TEST_RESPONSE is required in test mode".to_owned(),
        )
    })?;
    let response: SecretPromptResponse = serde_json::from_str(&raw_response).map_err(|error| {
        SecretPromptHelperError::InvalidRequest(format!(
            "Invalid ARTGOD_SECRET_PROMPT_TEST_RESPONSE: {error}"
        ))
    })?;
    if response.action() != action {
        return Err(SecretPromptHelperError::ActionMismatch {
            expected: action,
            actual: response.action(),
        });
    }
    Ok(Some(response))
}

fn read_request(
    action: SecretPromptAction,
) -> Result<SecretPromptRequest, SecretPromptHelperError> {
    let mut stdin = io::stdin().lock();
    let mut raw_request = String::new();
    stdin.read_line(&mut raw_request).map_err(|error| {
        SecretPromptHelperError::IoFailure(format!("Failed to read prompt request: {error}"))
    })?;
    if raw_request.trim().is_empty() {
        return Err(SecretPromptHelperError::InvalidRequest(format!(
            "Empty request payload for action {}",
            action.as_cli_arg()
        )));
    }
    serde_json::from_str::<SecretPromptRequest>(&raw_request).map_err(|error| {
        SecretPromptHelperError::InvalidRequest(format!("Invalid request payload: {error}"))
    })
}

fn handle_request(
    request: SecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    match request {
        SecretPromptRequest::Import(payload) => handle_import_request(payload),
        SecretPromptRequest::Unlock(payload) => handle_unlock_request(payload),
        SecretPromptRequest::RemoveConfirm(payload) => handle_remove_confirm_request(payload),
        SecretPromptRequest::ExportConfirm(payload) => handle_export_confirm_request(payload),
        SecretPromptRequest::ExportReveal(payload) => handle_export_reveal_request(payload),
    }
}

fn handle_import_request(
    payload: ImportSecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let Some(output) = prompt_ui::prompt_import(ImportPromptSpec {
        title: "Import Wallet",
        wallet_label_hint: payload.wallet_label_hint.as_deref().unwrap_or(""),
        passphrase_min_length: payload.passphrase_min_length,
        ok_label: "OK",
        cancel_label: "Cancel",
    })
    .map_err(|error| SecretPromptHelperError::UiFailure {
        action: SecretPromptAction::Import,
        message: error.to_string(),
    })?
    else {
        return Ok(cancelled(SecretPromptAction::Import));
    };

    let response = SecretPromptResponse::ImportSubmitted(ImportSecretPromptResponse {
        label: output.label,
        private_key: output.private_key,
        passphrase: output.passphrase,
        passphrase_confirmation: output.passphrase_confirmation,
    });
    Ok(response)
}

fn handle_unlock_request(
    payload: UnlockSecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Unlock wallet \"{}\" ({}) to {}",
        payload.wallet_label, payload.wallet_address, payload.reason
    );
    let Some(passphrase) = prompt_ui::prompt_text(TextPromptSpec {
        title: "Unlock Wallet",
        message: &message,
        initial_value: "",
        mode: TextPromptMode::Secret,
        ok_label: "Unlock",
        cancel_label: "Cancel",
        input_kind: TextInputKind::Passphrase,
        max_len: 256,
        validation: TextValidationSpec::None,
    })
    .map_err(|error| SecretPromptHelperError::UiFailure {
        action: SecretPromptAction::Unlock,
        message: error.to_string(),
    })?
    else {
        return Ok(cancelled(SecretPromptAction::Unlock));
    };
    Ok(SecretPromptResponse::UnlockSubmitted(
        UnlockSecretPromptResponse { passphrase },
    ))
}

fn handle_remove_confirm_request(
    payload: RemoveConfirmSecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Remove wallet \"{}\" ({}) from this device?",
        payload.wallet_label, payload.wallet_address
    );
    let Some(output) = prompt_ui::prompt_remove_confirmation(RemoveConfirmPromptSpec {
        title: "Remove Wallet",
        message: &message,
        confirm_label: "Remove",
        cancel_label: "Cancel",
        passphrase_message: "Enter wallet passphrase",
        passphrase_ok_label: "OK",
    })
    .map_err(|error| SecretPromptHelperError::UiFailure {
        action: SecretPromptAction::RemoveConfirm,
        message: error.to_string(),
    })?
    else {
        return Ok(cancelled(SecretPromptAction::RemoveConfirm));
    };
    Ok(SecretPromptResponse::RemoveConfirmSubmitted(
        RemoveConfirmSecretPromptResponse {
            passphrase: output.passphrase,
        },
    ))
}

fn handle_export_confirm_request(
    payload: ExportConfirmSecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Reveal the private key for wallet \"{}\" ({})?",
        payload.wallet_label, payload.wallet_address
    );
    let confirmation_message = format!("Type {} to continue", payload.expected_confirmation);
    let Some(output) = prompt_ui::prompt_export_confirmation(ExportConfirmPromptSpec {
        title: "Export Wallet",
        message: &message,
        confirm_label: "Reveal",
        cancel_label: "Cancel",
        typed_confirmation_message: &confirmation_message,
        typed_confirmation_ok_label: "OK",
        passphrase_message: "Enter wallet passphrase",
        passphrase_ok_label: "OK",
    })
    .map_err(|error| SecretPromptHelperError::UiFailure {
        action: SecretPromptAction::ExportConfirm,
        message: error.to_string(),
    })?
    else {
        return Ok(cancelled(SecretPromptAction::ExportConfirm));
    };
    Ok(SecretPromptResponse::ExportConfirmSubmitted(
        ExportConfirmSecretPromptResponse {
            passphrase: output.passphrase,
            typed_confirmation: output.typed_confirmation,
        },
    ))
}

fn handle_export_reveal_request(
    payload: ExportRevealSecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Wallet: {} ({})\n\nPrivate key:\n{}\n\nClipboard copy is disabled. Close this window when you are done.",
        payload.wallet_label, payload.wallet_address, payload.private_key
    );
    prompt_ui::reveal(RevealPromptSpec {
        title: "Export Wallet",
        message: &message,
        acknowledge_label: "Close",
    })
    .map_err(|error| SecretPromptHelperError::UiFailure {
        action: SecretPromptAction::ExportReveal,
        message: error.to_string(),
    })?;
    Ok(SecretPromptResponse::ExportRevealAcknowledged(
        ExportRevealAcknowledgedResponse { acknowledged: true },
    ))
}

fn cancelled(action: SecretPromptAction) -> SecretPromptResponse {
    SecretPromptResponse::Cancelled(CancelledSecretPromptResponse { action })
}

fn write_response(response: &SecretPromptResponse) -> Result<(), SecretPromptHelperError> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, response)
        .map_err(|error| SecretPromptHelperError::IoFailure(error.to_string()))?;
    stdout
        .write_all(b"\n")
        .map_err(|error| SecretPromptHelperError::IoFailure(error.to_string()))?;
    stdout
        .flush()
        .map_err(|error| SecretPromptHelperError::IoFailure(error.to_string()))?;
    Ok(())
}

#[derive(Debug, Error)]
enum SecretPromptHelperError {
    #[error("Prompt request was invalid: {0}")]
    InvalidRequest(String),
    #[error("Prompt action mismatch: expected {expected:?}, got {actual:?}")]
    ActionMismatch {
        expected: SecretPromptAction,
        actual: SecretPromptAction,
    },
    #[error("Prompt IO failed: {0}")]
    IoFailure(String),
    #[error("Prompt UI failed for {action:?}: {message}")]
    UiFailure {
        action: SecretPromptAction,
        message: String,
    },
}

impl SecretPromptHelperError {
    fn action(&self) -> Option<SecretPromptAction> {
        match self {
            Self::ActionMismatch { expected, .. } => Some(*expected),
            Self::UiFailure { action, .. } => Some(*action),
            Self::InvalidRequest(_) | Self::IoFailure(_) => None,
        }
    }

    fn code(&self) -> SecretPromptErrorCode {
        match self {
            Self::InvalidRequest(_) => SecretPromptErrorCode::InvalidRequest,
            Self::ActionMismatch { .. } => SecretPromptErrorCode::ActionMismatch,
            Self::IoFailure(_) | Self::UiFailure { .. } => SecretPromptErrorCode::InternalFailure,
        }
    }

    fn public_message(&self) -> String {
        match self {
            Self::InvalidRequest(message) => message.clone(),
            Self::ActionMismatch { expected, actual } => {
                format!("Expected {:?} request, got {:?}", expected, actual)
            }
            Self::IoFailure(_) | Self::UiFailure { .. } => "Secret prompt helper failed".to_owned(),
        }
    }
}
