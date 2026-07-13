mod generated_font;
mod owner_liveness;
mod prompt_ui;

use std::env;
use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use artgod_secret_prompt_protocol::{
    CancelledSecretPromptResponse, ErrorSecretPromptResponse, ExportConfirmSecretPromptRequest,
    ExportConfirmSecretPromptResponse, ExportRevealAcknowledgedResponse,
    ExportRevealSecretPromptRequest, ImportSecretPromptRequest, ImportSecretPromptResponse,
    RemoveConfirmSecretPromptRequest, RemoveConfirmSecretPromptResponse,
    SECRET_PROMPT_MAX_REQUEST_BYTES, SECRET_PROMPT_MAX_RESPONSE_BYTES, SecretPromptAction,
    SecretPromptErrorCode, SecretPromptRequest, SecretPromptResponse, UnlockBiddingMandateSummary,
    UnlockSecretPromptRequest, UnlockSecretPromptResponse,
};
use artgod_sensitive_process::harden_current_process;
use owner_liveness::OwnerLiveness;
use prompt_ui::{
    BiddingReviewPage, BiddingReviewRow, BiddingReviewValue, ExportConfirmPromptSpec,
    ImportPromptSpec, RemoveConfirmPromptSpec, RevealPromptSpec, UnlockPromptSpec,
};
use thiserror::Error;
use zeroize::Zeroizing;

fn main() -> ExitCode {
    // Disable ordinary process dumps before accepting a secret-bearing prompt request.
    if let Err(error) = harden_current_process() {
        eprintln!("Secret prompt sensitive-process hardening failed: {error}");
        return ExitCode::FAILURE;
    }

    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(SecretPromptHelperError::OwnerLost) => ExitCode::FAILURE,
        Err(error) => {
            let action = error.action().unwrap_or(SecretPromptAction::Unlock);
            let response = SecretPromptResponse::Error(ErrorSecretPromptResponse {
                action,
                code: error.code(),
                message: error.public_message(),
            });
            let _ = write_response(&response);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), SecretPromptHelperError> {
    let action = read_action_from_args()?;
    let request = read_request(action)?;

    if request.action() != action {
        return Err(SecretPromptHelperError::ActionMismatch {
            expected: action,
            actual: request.action(),
        });
    }

    let owner_liveness = OwnerLiveness::default();
    let response = handle_request(request, &owner_liveness)?;
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

fn read_request(
    action: SecretPromptAction,
) -> Result<SecretPromptRequest, SecretPromptHelperError> {
    let mut stdin = io::stdin().lock();
    read_request_from(action, &mut stdin)
}

fn read_request_from(
    action: SecretPromptAction,
    reader: impl BufRead,
) -> Result<SecretPromptRequest, SecretPromptHelperError> {
    let mut raw_request = Zeroizing::new(String::new());
    let bytes_read = reader
        .take((SECRET_PROMPT_MAX_REQUEST_BYTES + 2) as u64)
        .read_line(&mut raw_request)
        .map_err(|error| {
            SecretPromptHelperError::IoFailure(format!("Failed to read prompt request: {error}"))
        })?;
    if bytes_read == 0 {
        return Err(SecretPromptHelperError::OwnerLost);
    }
    if raw_request.len() > SECRET_PROMPT_MAX_REQUEST_BYTES + 1 {
        return Err(SecretPromptHelperError::InvalidRequest(format!(
            "Request payload exceeded {} bytes for action {}",
            SECRET_PROMPT_MAX_REQUEST_BYTES,
            action.as_cli_arg()
        )));
    }
    if !raw_request.ends_with('\n') {
        return Err(SecretPromptHelperError::OwnerLost);
    }
    let request_payload = raw_request
        .strip_suffix('\n')
        .unwrap_or(raw_request.as_str());
    let request_payload = request_payload
        .strip_suffix('\r')
        .unwrap_or(request_payload);
    parse_request_payload(action, request_payload)
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
    owner_liveness: &OwnerLiveness,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    match request {
        SecretPromptRequest::Import(payload) => handle_import_request(payload, owner_liveness),
        SecretPromptRequest::Unlock(payload) => handle_unlock_request(payload, owner_liveness),
        SecretPromptRequest::RemoveConfirm(payload) => {
            handle_remove_confirm_request(payload, owner_liveness)
        }
        SecretPromptRequest::ExportConfirm(payload) => {
            handle_export_confirm_request(payload, owner_liveness)
        }
        SecretPromptRequest::ExportReveal(payload) => {
            handle_export_reveal_request(payload, owner_liveness)
        }
    }
}

fn handle_import_request(
    payload: ImportSecretPromptRequest,
    owner_liveness: &OwnerLiveness,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let Some(output) = prompt_ui::prompt_import(
        ImportPromptSpec {
            title: "Import Wallet",
            wallet_label_hint: payload.wallet_label_hint.as_deref().unwrap_or(""),
            passphrase_min_length: payload.passphrase_min_length,
            ok_label: "OK",
            cancel_label: "Cancel",
        },
        owner_liveness,
    )
    .map_err(|error| map_prompt_ui_error(SecretPromptAction::Import, error))?
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
    owner_liveness: &OwnerLiveness,
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
    let Some(passphrase) = prompt_ui::prompt_unlock(
        UnlockPromptSpec {
            title: "Unlock Wallet",
            passphrase_message: &passphrase_message,
            review_pages,
            unlock_label: "Unlock",
            cancel_label: "Cancel",
        },
        owner_liveness,
    )
    .map_err(|error| map_prompt_ui_error(SecretPromptAction::Unlock, error))?
    else {
        return Ok(cancelled(SecretPromptAction::Unlock));
    };
    Ok(SecretPromptResponse::UnlockSubmitted(
        UnlockSecretPromptResponse { passphrase },
    ))
}

fn build_bidding_mandate_review_pages(
    summary: &UnlockBiddingMandateSummary,
) -> Vec<BiddingReviewPage> {
    let mut pages = Vec::with_capacity(summary.collections.len() + 1);
    let trait_offer_policy = if summary.trait_offers_enabled {
        "enabled; OpenSea's pinned SignedZone is trusted"
    } else {
        "disabled"
    };
    pages.push(BiddingReviewPage {
        heading: Some("Bidding authorization".to_owned()),
        rows: vec![
            BiddingReviewRow::plain("Network", render_prompt_value(summary.chain_name.as_str())),
            BiddingReviewRow::plain("Chain ID", format!("#{}", summary.chain_id)),
            BiddingReviewRow::with_values(
                "WETH allowance cap",
                vec![
                    BiddingReviewValue::amount(format!(
                        "{} WETH",
                        render_prompt_value(summary.weth_allowance_cap_eth.as_str())
                    )),
                    BiddingReviewValue::plain(" for the OpenSea conduit"),
                ],
            ),
            BiddingReviewRow::with_values(
                "Minimum priority fee per gas",
                vec![
                    BiddingReviewValue::amount(format!(
                        "{} Gwei",
                        render_prompt_value(summary.min_priority_fee_per_gas_gwei.as_str())
                    )),
                    BiddingReviewValue::plain(" per gas"),
                ],
            ),
            BiddingReviewRow::with_values(
                "Maximum fee per gas",
                vec![
                    BiddingReviewValue::amount(format!(
                        "{} Gwei",
                        render_prompt_value(summary.max_fee_per_gas_gwei.as_str())
                    )),
                    BiddingReviewValue::plain(" per gas"),
                ],
            ),
            BiddingReviewRow::with_values(
                "Maximum network fee for one WETH approval transaction",
                vec![
                    BiddingReviewValue::amount(format!(
                        "{} ETH",
                        render_prompt_value(summary.max_total_gas_fee_eth.as_str())
                    )),
                    BiddingReviewValue::plain(" per approval transaction"),
                ],
            ),
            BiddingReviewRow::plain(
                "Pending transaction policy",
                render_prompt_value(summary.pending_nonce_policy.as_str()),
            ),
            BiddingReviewRow::plain("Trait offers", trait_offer_policy),
            BiddingReviewRow::plain("Collections", summary.collections.len().to_string()),
        ],
    });
    for (index, collection) in summary.collections.iter().enumerate() {
        let mut rows = vec![
            BiddingReviewRow::plain(
                format!("Collection {}/{}", index + 1, summary.collections.len()),
                render_prompt_value(collection.artgod_slug.as_str()),
            ),
            BiddingReviewRow::plain(
                "ArtGod collection ID",
                format!("#{}", collection.collection_id),
            ),
            BiddingReviewRow::plain(
                "OpenSea slug",
                render_prompt_value(collection.opensea_slug.as_str()),
            ),
            BiddingReviewRow::plain(
                "Contract address",
                render_prompt_value(collection.contract_address.as_str()),
            ),
            BiddingReviewRow::plain(
                "Token scope",
                render_prompt_value(collection.token_scope_label.as_str()),
            ),
        ];
        rows.extend(collection.token_scope_items.iter().map(|item| {
            BiddingReviewRow::indented_plain(
                2,
                render_prompt_value(item.label.as_str()),
                render_prompt_value(item.value.as_str()),
            )
        }));
        rows.push(BiddingReviewRow::with_values(
            "Maximum WETH for any one NFT",
            vec![BiddingReviewValue::amount(format!(
                "{} WETH",
                render_prompt_value(collection.max_unit_bid_eth.as_str())
            ))],
        ));
        rows.push(BiddingReviewRow::plain(
            "Maximum NFTs per offer",
            collection.max_quantity.to_string(),
        ));
        pages.push(BiddingReviewPage {
            heading: None,
            rows,
        });
    }
    pages
}

fn render_prompt_value(value: &str) -> String {
    let mut rendered = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => rendered.push_str(r"\\"),
            ' '..='~' => rendered.push(character),
            _ => rendered.extend(character.escape_unicode()),
        }
    }
    rendered
}

fn handle_remove_confirm_request(
    payload: RemoveConfirmSecretPromptRequest,
    owner_liveness: &OwnerLiveness,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Remove wallet \"{}\" ({}) from this device?",
        payload.wallet_label, payload.wallet_address
    );
    let confirmation_message = format!("Type {} to continue", payload.expected_confirmation);
    let Some(output) = prompt_ui::prompt_remove_confirmation(
        RemoveConfirmPromptSpec {
            title: "Remove Wallet",
            message: &message,
            confirm_label: "Remove",
            cancel_label: "Cancel",
            typed_confirmation_message: &confirmation_message,
            typed_confirmation_ok_label: "OK",
            expected_confirmation: &payload.expected_confirmation,
            passphrase_message: "Enter wallet passphrase",
            passphrase_ok_label: "OK",
        },
        owner_liveness,
    )
    .map_err(|error| map_prompt_ui_error(SecretPromptAction::RemoveConfirm, error))?
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
    owner_liveness: &OwnerLiveness,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = format!(
        "Reveal the private key for wallet \"{}\" ({})?",
        payload.wallet_label, payload.wallet_address
    );
    let confirmation_message = format!("Type {} to continue", payload.expected_confirmation);
    let Some(output) = prompt_ui::prompt_export_confirmation(
        ExportConfirmPromptSpec {
            title: "Export Wallet",
            message: &message,
            confirm_label: "Reveal",
            cancel_label: "Cancel",
            typed_confirmation_message: &confirmation_message,
            typed_confirmation_ok_label: "OK",
            expected_confirmation: &payload.expected_confirmation,
            passphrase_message: "Enter wallet passphrase",
            passphrase_ok_label: "OK",
        },
        owner_liveness,
    )
    .map_err(|error| map_prompt_ui_error(SecretPromptAction::ExportConfirm, error))?
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
    owner_liveness: &OwnerLiveness,
) -> Result<SecretPromptResponse, SecretPromptHelperError> {
    let message = Zeroizing::new(format!(
        "Wallet: {} ({})\n\nPrivate key:\n{}\n\nClipboard copy is disabled. Close this window when you are done.",
        payload.wallet_label,
        payload.wallet_address,
        payload.private_key.as_str()
    ));
    prompt_ui::reveal(
        RevealPromptSpec {
            title: "Export Wallet",
            message: &message,
            acknowledge_label: "Close",
        },
        owner_liveness,
    )
    .map_err(|error| map_prompt_ui_error(SecretPromptAction::ExportReveal, error))?;
    Ok(SecretPromptResponse::ExportRevealAcknowledged(
        ExportRevealAcknowledgedResponse { acknowledged: true },
    ))
}

fn cancelled(action: SecretPromptAction) -> SecretPromptResponse {
    SecretPromptResponse::Cancelled(CancelledSecretPromptResponse { action })
}

fn map_prompt_ui_error(
    action: SecretPromptAction,
    error: prompt_ui::PromptUiError,
) -> SecretPromptHelperError {
    match error {
        prompt_ui::PromptUiError::OwnerLost => SecretPromptHelperError::OwnerLost,
        prompt_ui::PromptUiError::ProtocolViolation => SecretPromptHelperError::ProtocolViolation,
        other => SecretPromptHelperError::UiFailure {
            action,
            message: other.to_string(),
        },
    }
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
    #[error("Secret prompt owner was lost")]
    OwnerLost,
    #[error("Secret prompt received additional stdin bytes")]
    ProtocolViolation,
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
            Self::OwnerLost
            | Self::ProtocolViolation
            | Self::InvalidRequest(_)
            | Self::IoFailure(_) => None,
        }
    }

    fn code(&self) -> SecretPromptErrorCode {
        match self {
            Self::OwnerLost | Self::ProtocolViolation | Self::InvalidRequest(_) => {
                SecretPromptErrorCode::InvalidRequest
            }
            Self::ActionMismatch { .. } => SecretPromptErrorCode::ActionMismatch,
            Self::IoFailure(_) | Self::UiFailure { .. } => SecretPromptErrorCode::InternalFailure,
        }
    }

    fn public_message(&self) -> String {
        match self {
            Self::OwnerLost => "Secret prompt owner was lost".to_owned(),
            Self::ProtocolViolation => {
                "Secret prompt received unexpected additional input".to_owned()
            }
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
        SecretPromptResponse, UnlockBiddingCollectionSummary, UnlockBiddingTokenScopeItem,
        UnlockSecretPromptRequest, UnlockSecretPromptResponse,
    };
    use std::io::Cursor;
    use std::process::Command;

    const HELPER_HARDENING_TEST_ENTRY: &str = "tests::helper_process_hardening_entry";
    const HELPER_HARDENING_REPORT: &str = "helper_sensitive_process_hardened";

    fn review_row<'a>(page: &'a BiddingReviewPage, label: &str) -> &'a BiddingReviewRow {
        page.rows
            .iter()
            .find(|row| row.label == label)
            .unwrap_or_else(|| panic!("missing bidding review row {label}"))
    }

    #[test]
    fn helper_process_reports_hardening_from_an_isolated_subprocess() {
        let output = Command::new(std::env::current_exe().expect("helper test executable exists"))
            .args([
                "--ignored",
                "--exact",
                HELPER_HARDENING_TEST_ENTRY,
                "--nocapture",
            ])
            .output()
            .expect("helper hardening test entry starts");

        assert!(output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(HELPER_HARDENING_REPORT),
            "helper hardening subprocess did not report its verified state"
        );
    }

    #[test]
    #[ignore = "subprocess entrypoint for irreversible helper-process hardening"]
    fn helper_process_hardening_entry() {
        harden_current_process().expect("helper process hardening is installed");
        println!("{HELPER_HARDENING_REPORT}");
    }

    #[test]
    fn parse_request_payload_rejects_oversized_input() {
        let oversized = "x".repeat(SECRET_PROMPT_MAX_REQUEST_BYTES + 1);
        let error =
            parse_request_payload(SecretPromptAction::Unlock, oversized.as_str()).unwrap_err();
        assert!(matches!(error, SecretPromptHelperError::InvalidRequest(_)));
    }

    #[test]
    fn read_request_rejects_an_oversized_line_without_reading_to_eof() {
        let oversized = "x".repeat(SECRET_PROMPT_MAX_REQUEST_BYTES + 2);
        let reader = Cursor::new(oversized.into_bytes());

        let error = read_request_from(SecretPromptAction::Unlock, reader).unwrap_err();

        assert!(matches!(error, SecretPromptHelperError::InvalidRequest(_)));
    }

    #[test]
    fn read_request_treats_eof_before_a_request_as_owner_loss() {
        let error = read_request_from(SecretPromptAction::Unlock, Cursor::new(Vec::new()))
            .expect_err("closed owner stdin must not become a protocol response");

        assert!(matches!(error, SecretPromptHelperError::OwnerLost));
    }

    #[test]
    fn read_request_treats_eof_before_newline_as_owner_loss() {
        let request =
            br#"{"type":"unlock","walletLabel":"Primary","walletAddress":"0x123","reason":"test"}"#;
        let error = read_request_from(SecretPromptAction::Unlock, Cursor::new(request))
            .expect_err("partial owner request must not open the prompt");

        assert!(matches!(error, SecretPromptHelperError::OwnerLost));
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
            weth_allowance_cap_eth: "0.5".to_owned(),
            min_priority_fee_per_gas_gwei: "0.1".to_owned(),
            max_fee_per_gas_gwei: "10".to_owned(),
            max_total_gas_fee_eth: "0.01".to_owned(),
            pending_nonce_policy: "fail if the wallet already has pending transactions".to_owned(),
            trait_offers_enabled: true,
            collections: vec![UnlockBiddingCollectionSummary {
                collection_id: 7,
                artgod_slug: "example".to_owned(),
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                opensea_slug: "example-opensea".to_owned(),
                token_scope_label: "all contract tokens".to_owned(),
                token_scope_items: Vec::new(),
                max_unit_bid_eth: "1.25".to_owned(),
                max_quantity: 1,
            }],
        });

        assert_eq!(pages[0].heading.as_deref(), Some("Bidding authorization"));
        assert_eq!(
            pages[0].rows[0],
            BiddingReviewRow::plain("Network", "Ethereum")
        );
        assert_eq!(pages[0].rows[1], BiddingReviewRow::plain("Chain ID", "#1"));
        assert!(pages[0].rows.iter().all(|row| row.label != "Mode"));
        assert!(pages[0].rows.iter().all(|row| {
            row.values.iter().all(|value| match value {
                BiddingReviewValue::Plain(value) | BiddingReviewValue::Amount(value) => {
                    !value.contains("dry run")
                }
            })
        }));
        assert_eq!(
            review_row(&pages[0], "WETH allowance cap").values,
            vec![
                BiddingReviewValue::amount("0.5 WETH"),
                BiddingReviewValue::plain(" for the OpenSea conduit"),
            ]
        );
        assert_eq!(
            review_row(&pages[0], "Minimum priority fee per gas").values,
            vec![
                BiddingReviewValue::amount("0.1 Gwei"),
                BiddingReviewValue::plain(" per gas"),
            ]
        );
        assert_eq!(
            review_row(&pages[0], "Maximum fee per gas").values,
            vec![
                BiddingReviewValue::amount("10 Gwei"),
                BiddingReviewValue::plain(" per gas"),
            ]
        );
        assert_eq!(
            review_row(
                &pages[0],
                "Maximum network fee for one WETH approval transaction"
            )
            .values,
            vec![
                BiddingReviewValue::amount("0.01 ETH"),
                BiddingReviewValue::plain(" per approval transaction"),
            ]
        );
        assert_eq!(
            review_row(&pages[0], "Pending transaction policy").values,
            vec![BiddingReviewValue::plain(
                "fail if the wallet already has pending transactions"
            )]
        );
        assert_eq!(
            review_row(&pages[0], "Trait offers").values,
            vec![BiddingReviewValue::plain(
                "enabled; OpenSea's pinned SignedZone is trusted"
            )]
        );
        assert_eq!(
            review_row(&pages[1], "ArtGod collection ID").values,
            vec![BiddingReviewValue::plain("#7")]
        );
        assert_eq!(
            review_row(&pages[1], "Maximum WETH for any one NFT").values,
            vec![BiddingReviewValue::amount("1.25 WETH")]
        );
        assert_eq!(
            review_row(&pages[1], "Maximum NFTs per offer").values,
            vec![BiddingReviewValue::plain("1")]
        );
    }

    #[test]
    fn every_collection_scope_review_fits_the_admin_sized_prompt() {
        let collection =
            |collection_id, artgod_slug: &str, token_scope_label: &str, token_scope_items| {
                UnlockBiddingCollectionSummary {
                    collection_id,
                    artgod_slug: artgod_slug.to_owned(),
                    contract_address: "0xffffffffffffffffffffffffffffffffffffffff".to_owned(),
                    opensea_slug: artgod_slug.to_owned(),
                    token_scope_label: token_scope_label.to_owned(),
                    token_scope_items,
                    max_unit_bid_eth: "1.25".to_owned(),
                    max_quantity: 1,
                }
            };
        let pages = build_bidding_mandate_review_pages(&UnlockBiddingMandateSummary {
            chain_id: u64::MAX,
            chain_name: "Ethereum".to_owned(),
            weth_allowance_cap_eth: "0.5".to_owned(),
            min_priority_fee_per_gas_gwei: "0.1".to_owned(),
            max_fee_per_gas_gwei: "10".to_owned(),
            max_total_gas_fee_eth: "0.01".to_owned(),
            pending_nonce_policy: "fail if the wallet already has pending transactions".to_owned(),
            trait_offers_enabled: true,
            collections: vec![
                collection(
                    1,
                    "all-tokens",
                    "all contract tokens",
                    vec![UnlockBiddingTokenScopeItem {
                        label: "scope".to_owned(),
                        value: "all contract tokens".to_owned(),
                    }],
                ),
                collection(
                    u64::MAX,
                    "token-range",
                    "token range",
                    vec![
                        UnlockBiddingTokenScopeItem {
                            label: "scope".to_owned(),
                            value: "token range".to_owned(),
                        },
                        UnlockBiddingTokenScopeItem {
                            label: "start token".to_owned(),
                            value: "0".to_owned(),
                        },
                        UnlockBiddingTokenScopeItem {
                            label: "total supply".to_owned(),
                            value: "9911".to_owned(),
                        },
                    ],
                ),
                collection(
                    3,
                    "explicit-token-ids",
                    "explicit token ids",
                    vec![
                        UnlockBiddingTokenScopeItem {
                            label: "scope".to_owned(),
                            value: "explicit token ids".to_owned(),
                        },
                        UnlockBiddingTokenScopeItem {
                            label: "token count".to_owned(),
                            value: "42".to_owned(),
                        },
                    ],
                ),
            ],
        });

        prompt_ui::validate_bidding_review_pages(&pages)
            .expect("every canonical bidding review page should fit");
        assert_eq!(
            pages[1]
                .rows
                .iter()
                .filter(|row| row.indentation_columns > 0)
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["scope"]
        );
        assert_eq!(
            pages[2]
                .rows
                .iter()
                .filter(|row| row.indentation_columns > 0)
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["scope", "start token", "total supply"]
        );
        assert_eq!(
            pages[3]
                .rows
                .iter()
                .filter(|row| row.indentation_columns > 0)
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["scope", "token count"]
        );
    }

    #[test]
    fn collection_scope_labels_and_values_are_rendered_without_reinterpretation() {
        let pages = build_bidding_mandate_review_pages(&UnlockBiddingMandateSummary {
            chain_id: 1,
            chain_name: "Ethereum".to_owned(),
            weth_allowance_cap_eth: "0.5".to_owned(),
            min_priority_fee_per_gas_gwei: "0.1".to_owned(),
            max_fee_per_gas_gwei: "10".to_owned(),
            max_total_gas_fee_eth: "0.01".to_owned(),
            pending_nonce_policy: "fail if the wallet already has pending transactions".to_owned(),
            trait_offers_enabled: false,
            collections: vec![UnlockBiddingCollectionSummary {
                collection_id: 1,
                artgod_slug: "example".to_owned(),
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                opensea_slug: "example".to_owned(),
                token_scope_label: "custom scope".to_owned(),
                token_scope_items: vec![UnlockBiddingTokenScopeItem {
                    label: "label: with punctuation".to_owned(),
                    value: "value: with punctuation".to_owned(),
                }],
                max_unit_bid_eth: "1.25".to_owned(),
                max_quantity: 1,
            }],
        });

        assert_eq!(
            review_row(&pages[1], "label: with punctuation"),
            &BiddingReviewRow::indented_plain(
                2,
                "label: with punctuation",
                "value: with punctuation"
            )
        );
    }

    #[test]
    fn bidding_review_values_are_never_silently_truncated_or_dropped() {
        // This boundary fixture crosses the former truncation length deliberately.
        let full_ascii_value = "x".repeat(121);

        assert_eq!(render_prompt_value(&full_ascii_value), full_ascii_value);
        assert_eq!(render_prompt_value("café\n"), r"caf\u{e9}\u{a}");
        assert_eq!(render_prompt_value(r"\u{e9}"), r"\\u{e9}");
        assert_ne!(render_prompt_value("é"), render_prompt_value(r"\u{e9}"));
    }

    #[test]
    fn serialize_response_payload_appends_newline() {
        let response = SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
            passphrase: Zeroizing::new("secret".to_owned()),
        });
        let payload = serialize_response_payload(&response).unwrap();
        assert!(payload.ends_with(b"\n"));
    }
}
