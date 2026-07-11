mod generated_font;
mod prompt_ui;

use std::env;
use std::io::{self, BufRead, Write};

use artgod_secret_prompt_protocol::{
    CancelledSecretPromptResponse, ErrorSecretPromptResponse, ExportConfirmSecretPromptRequest,
    ExportConfirmSecretPromptResponse, ExportRevealAcknowledgedResponse,
    ExportRevealSecretPromptRequest, ImportSecretPromptRequest, ImportSecretPromptResponse,
    RemoveConfirmSecretPromptRequest, RemoveConfirmSecretPromptResponse,
    SECRET_PROMPT_MAX_REQUEST_BYTES, SECRET_PROMPT_MAX_RESPONSE_BYTES, SecretPromptAction,
    SecretPromptErrorCode, SecretPromptRequest, SecretPromptResponse, UnlockBiddingMandateSummary,
    UnlockSecretPromptRequest, UnlockSecretPromptResponse,
};
use prompt_ui::{
    ExportConfirmPromptSpec, ImportPromptSpec, RemoveConfirmPromptSpec, RevealPromptSpec,
    UnlockPromptSpec,
};
use thiserror::Error;
use zeroize::Zeroizing;

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
    let mut raw_request = Zeroizing::new(String::new());
    stdin.read_line(&mut raw_request).map_err(|error| {
        SecretPromptHelperError::IoFailure(format!("Failed to read prompt request: {error}"))
    })?;
    parse_request_payload(action, raw_request.as_str())
}

fn parse_request_payload(
    action: SecretPromptAction,
    raw_request: &str,
) -> Result<SecretPromptRequest, SecretPromptHelperError> {
    if raw_request.trim().is_empty() {
        return Err(SecretPromptHelperError::InvalidRequest(format!(
            "Empty request payload for action {}",
            action.as_cli_arg()
        )));
    }
    if raw_request.len() > SECRET_PROMPT_MAX_REQUEST_BYTES {
        return Err(SecretPromptHelperError::InvalidRequest(format!(
            "Request payload exceeded {} bytes for action {}",
            SECRET_PROMPT_MAX_REQUEST_BYTES,
            action.as_cli_arg()
        )));
    }
    serde_json::from_str::<SecretPromptRequest>(raw_request).map_err(|error| {
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
    let passphrase_message = format!(
        "Unlock wallet \"{}\" ({}) to {}",
        payload.wallet_label, payload.wallet_address, payload.reason
    );
    let review_pages = payload
        .bidding_mandate
        .as_ref()
        .map(build_bidding_mandate_review_pages)
        .unwrap_or_default();
    let Some(passphrase) = prompt_ui::prompt_unlock(UnlockPromptSpec {
        title: "Unlock Wallet",
        passphrase_message: &passphrase_message,
        review_pages,
        unlock_label: "Unlock",
        cancel_label: "Cancel",
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

fn build_bidding_mandate_review_pages(summary: &UnlockBiddingMandateSummary) -> Vec<String> {
    let mut pages = Vec::with_capacity(summary.collections.len() + 1);
    pages.push(format!(
        "Bidding authorization\nNetwork: {}\nChain ID: #{}\nMode: {}\nWETH allowance cap: {} WETH\nTrait offers: {}\nCollections: {}",
        compact_prompt_value(summary.chain_name.as_str()),
        summary.chain_id,
        if summary.dry_run { "dry run" } else { "live orders" },
        compact_prompt_value(summary.weth_allowance_cap_eth.as_str()),
        if summary.trait_offers_enabled { "enabled" } else { "disabled" },
        summary.collections.len(),
    ));
    for (index, collection) in summary.collections.iter().enumerate() {
        let mut lines = vec![
            format!(
                "Collection {}/{}: {}",
                index + 1,
                summary.collections.len(),
                compact_prompt_value(collection.artgod_slug.as_str())
            ),
            format!("ArtGod collection ID: #{}", collection.collection_id),
            format!(
                "OpenSea slug: {}",
                compact_prompt_value(collection.opensea_slug.as_str())
            ),
            format!(
                "Contract address: {}",
                compact_prompt_value(collection.contract_address.as_str())
            ),
            format!(
                "Token scope: {}",
                compact_prompt_value(collection.token_scope_label.as_str())
            ),
        ];
        lines.extend(collection.token_scope_items.iter().map(|item| {
            format!(
                "  {}: {}",
                compact_prompt_value(item.label.as_str()),
                compact_prompt_value(item.value.as_str())
            )
        }));
        lines.push(format!(
            "Maximum WETH per NFT: {}",
            compact_prompt_value(collection.max_unit_bid_eth.as_str())
        ));
        lines.push(format!(
            "Maximum NFTs per offer: {}",
            collection.max_quantity
        ));
        pages.push(lines.join("\n"));
    }
    pages
}

fn compact_prompt_value(value: &str) -> String {
    const MAX_PROMPT_VALUE_CHARS: usize = 120;
    value
        .chars()
        .filter_map(|character| match character {
            ' '..='~' => Some(character),
            _ if character.is_whitespace() => Some(' '),
            _ => None,
        })
        .take(MAX_PROMPT_VALUE_CHARS)
        .collect()
}

fn handle_remove_confirm_request(
    payload: RemoveConfirmSecretPromptRequest,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Remove wallet \"{}\" ({}) from this device?",
        payload.wallet_label, payload.wallet_address
    );
    let confirmation_message = format!("Type {} to continue", payload.expected_confirmation);
    let Some(output) = prompt_ui::prompt_remove_confirmation(RemoveConfirmPromptSpec {
        title: "Remove Wallet",
        message: &message,
        confirm_label: "Remove",
        cancel_label: "Cancel",
        typed_confirmation_message: &confirmation_message,
        typed_confirmation_ok_label: "OK",
        expected_confirmation: &payload.expected_confirmation,
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
            typed_confirmation: output.typed_confirmation,
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
        expected_confirmation: &payload.expected_confirmation,
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
    let response_payload = serialize_response_payload(response)?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&response_payload)
        .map_err(|error| SecretPromptHelperError::IoFailure(error.to_string()))?;
    stdout
        .flush()
        .map_err(|error| SecretPromptHelperError::IoFailure(error.to_string()))?;
    Ok(())
}

fn serialize_response_payload(
    response: &SecretPromptResponse,
) -> Result<Zeroizing<Vec<u8>>, SecretPromptHelperError> {
    let response_payload = serde_json::to_vec(response)
        .map_err(|error| SecretPromptHelperError::IoFailure(error.to_string()))?;
    if response_payload.len() > SECRET_PROMPT_MAX_RESPONSE_BYTES {
        return Err(SecretPromptHelperError::IoFailure(format!(
            "Response payload exceeded {} bytes",
            SECRET_PROMPT_MAX_RESPONSE_BYTES
        )));
    }
    let mut response_payload = Zeroizing::new(response_payload);
    response_payload.push(b'\n');
    Ok(response_payload)
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

#[cfg(test)]
mod tests {
    use super::*;
    use artgod_secret_prompt_protocol::{
        SecretPromptResponse, UnlockBiddingCollectionSummary, UnlockSecretPromptRequest,
        UnlockSecretPromptResponse,
    };

    #[test]
    fn parse_request_payload_rejects_oversized_input() {
        let oversized = "x".repeat(SECRET_PROMPT_MAX_REQUEST_BYTES + 1);
        let error =
            parse_request_payload(SecretPromptAction::Unlock, oversized.as_str()).unwrap_err();
        assert!(matches!(error, SecretPromptHelperError::InvalidRequest(_)));
    }

    #[test]
    fn parse_request_payload_accepts_valid_json() {
        let request = parse_request_payload(
            SecretPromptAction::Unlock,
            r#"{"type":"unlock","walletLabel":"Primary","walletAddress":"0x123","reason":"test"}"#,
        )
        .unwrap();
        assert_eq!(
            request,
            SecretPromptRequest::Unlock(UnlockSecretPromptRequest {
                wallet_label: "Primary".to_owned(),
                wallet_address: "0x123".to_owned(),
                reason: "test".to_owned(),
                bidding_mandate: None,
            })
        );
    }

    #[test]
    fn bidding_review_names_the_network_before_its_qualified_chain_id() {
        let pages = build_bidding_mandate_review_pages(&UnlockBiddingMandateSummary {
            chain_id: 1,
            chain_name: "Ethereum".to_owned(),
            dry_run: false,
            weth_allowance_cap_eth: "0.5".to_owned(),
            trait_offers_enabled: true,
            collections: vec![UnlockBiddingCollectionSummary {
                collection_id: 7,
                artgod_slug: "example".to_owned(),
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                opensea_slug: "example-opensea".to_owned(),
                token_scope_label: "all contract tokens".to_owned(),
                token_scope_items: Vec::new(),
                max_unit_bid_eth: "1.25".to_owned(),
                max_quantity: 2,
            }],
        });

        assert!(pages[0].starts_with("Bidding authorization\nNetwork: Ethereum\nChain ID: #1"));
        assert!(pages[1].contains("ArtGod collection ID: #7"));
        assert!(pages[1].contains("Maximum WETH per NFT: 1.25"));
        assert!(pages[1].contains("Maximum NFTs per offer: 2"));
    }

    #[test]
    fn serialize_response_payload_appends_newline() {
        let response = SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
            passphrase: "secret".to_owned(),
        });
        let payload = serialize_response_payload(&response).unwrap();
        assert!(payload.ends_with(b"\n"));
    }
}
