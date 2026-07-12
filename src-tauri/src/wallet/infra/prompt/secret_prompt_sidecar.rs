use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use artgod_secret_prompt_protocol::{
    ExportConfirmSecretPromptRequest, ExportRevealAcknowledgedResponse,
    ExportRevealSecretPromptRequest, ImportSecretPromptRequest, RemoveConfirmSecretPromptRequest,
    SECRET_PROMPT_MAX_REQUEST_BYTES, SECRET_PROMPT_MAX_RESPONSE_BYTES, SecretPromptAction,
    SecretPromptErrorCode, SecretPromptRequest, SecretPromptResponse, UnlockBiddingMandateSummary,
    UnlockSecretPromptRequest,
};
use futures_util::future::{Either, select};
use futures_util::pin_mut;
use tauri::AppHandle;
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use thiserror::Error;
use zeroize::Zeroizing;

const SECRET_PROMPT_SIDECAR_NAME: &str = "artgod-secret-prompt";
const SECRET_PROMPT_MAX_STDERR_BYTES: usize = 4 * 1024;

/// Launches the bundled native secret prompt helper via Tauri's sidecar runtime.
#[derive(Clone, Debug)]
pub struct SecretPromptSidecar {
    sidecar_name: String,
    coordinator: Arc<SecretPromptCoordinator>,
}

#[derive(Debug, Default)]
struct SecretPromptCoordinator {
    active_action: Mutex<Option<SecretPromptAction>>,
}

struct SecretPromptLease {
    coordinator: Arc<SecretPromptCoordinator>,
    action: SecretPromptAction,
}

/// Cancellation port supplied by a lifecycle owner for a native prompt request.
pub(crate) trait SecretPromptCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;

    fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

impl Default for SecretPromptSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretPromptSidecar {
    /// Creates a sidecar adapter using the canonical helper name.
    pub fn new() -> Self {
        Self {
            sidecar_name: SECRET_PROMPT_SIDECAR_NAME.to_owned(),
            coordinator: Arc::new(SecretPromptCoordinator::default()),
        }
    }

    /// Prompts natively for wallet import inputs.
    pub async fn request_import(
        &self,
        app: &AppHandle,
        wallet_label_hint: Option<String>,
        passphrase_min_length: usize,
    ) -> Result<ImportPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::Import(ImportSecretPromptRequest {
                    wallet_label_hint,
                    passphrase_min_length,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::ImportSubmitted(payload) => Ok(ImportPromptOutput {
                label: payload.label,
                private_key: Zeroizing::new(payload.private_key),
                passphrase: Zeroizing::new(payload.passphrase),
                passphrase_confirmation: Zeroizing::new(payload.passphrase_confirmation),
            }),
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::Import,
                received: other.action(),
            }),
        }
    }

    /// Prompts natively for a wallet unlock passphrase.
    pub async fn request_unlock(
        &self,
        app: &AppHandle,
        wallet_label: String,
        wallet_address: String,
        reason: String,
        bidding_mandate: Option<UnlockBiddingMandateSummary>,
        cancellation: &dyn SecretPromptCancellation,
    ) -> Result<UnlockPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::Unlock(UnlockSecretPromptRequest {
                    wallet_label,
                    wallet_address,
                    reason,
                    bidding_mandate,
                }),
                Some(cancellation),
            )
            .await?;
        match response {
            SecretPromptResponse::UnlockSubmitted(payload) => Ok(UnlockPromptOutput {
                passphrase: Zeroizing::new(payload.passphrase),
            }),
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::Unlock,
                received: other.action(),
            }),
        }
    }

    /// Prompts natively for wallet remove confirmation plus passphrase.
    pub async fn request_remove_confirmation(
        &self,
        app: &AppHandle,
        wallet_label: String,
        wallet_address: String,
        expected_confirmation: String,
    ) -> Result<RemoveConfirmPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::RemoveConfirm(RemoveConfirmSecretPromptRequest {
                    wallet_label,
                    wallet_address,
                    expected_confirmation,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::RemoveConfirmSubmitted(payload) => {
                Ok(RemoveConfirmPromptOutput {
                    passphrase: Zeroizing::new(payload.passphrase),
                    typed_confirmation: payload.typed_confirmation,
                })
            }
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::RemoveConfirm,
                received: other.action(),
            }),
        }
    }

    /// Prompts natively for wallet export confirmation plus passphrase.
    pub async fn request_export_confirmation(
        &self,
        app: &AppHandle,
        wallet_label: String,
        wallet_address: String,
        expected_confirmation: String,
    ) -> Result<ExportConfirmPromptOutput, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::ExportConfirm(ExportConfirmSecretPromptRequest {
                    wallet_label,
                    wallet_address,
                    expected_confirmation,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::ExportConfirmSubmitted(payload) => {
                Ok(ExportConfirmPromptOutput {
                    passphrase: Zeroizing::new(payload.passphrase),
                    typed_confirmation: payload.typed_confirmation,
                })
            }
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::ExportConfirm,
                received: other.action(),
            }),
        }
    }

    /// Reveals the plaintext private key in the helper's native window exactly once.
    pub async fn reveal_exported_private_key(
        &self,
        app: &AppHandle,
        input: ExportRevealPromptInput,
    ) -> Result<ExportRevealAcknowledgedResponse, SecretPromptError> {
        let response = self
            .run_prompt(
                app,
                SecretPromptRequest::ExportReveal(ExportRevealSecretPromptRequest {
                    wallet_label: input.wallet_label,
                    wallet_address: input.wallet_address,
                    private_key: input.private_key,
                }),
                None,
            )
            .await?;
        match response {
            SecretPromptResponse::ExportRevealAcknowledged(payload) => Ok(payload),
            other => Err(SecretPromptError::UnexpectedResponse {
                expected: SecretPromptAction::ExportReveal,
                received: other.action(),
            }),
        }
    }

    async fn run_prompt(
        &self,
        app: &AppHandle,
        request: SecretPromptRequest,
        cancellation: Option<&dyn SecretPromptCancellation>,
    ) -> Result<SecretPromptResponse, SecretPromptError> {
        let request_action = request.action();
        let _prompt_lease = self.coordinator.reserve(request_action)?;
        if cancellation.is_some_and(SecretPromptCancellation::is_cancelled) {
            return Err(SecretPromptError::LifecycleCancelled {
                action: request_action,
            });
        }
        let request_payload =
            serde_json::to_vec(&request).map_err(|error| SecretPromptError::ProtocolFailure {
                message: format!("Failed to serialize secret prompt request: {error}"),
            })?;
        if request_payload.len() > SECRET_PROMPT_MAX_REQUEST_BYTES {
            return Err(SecretPromptError::ProtocolFailure {
                message: format!(
                    "Secret prompt request exceeded {} bytes",
                    SECRET_PROMPT_MAX_REQUEST_BYTES
                ),
            });
        }

        let sidecar_command = app
            .shell()
            .sidecar(&self.sidecar_name)
            .map_err(|error| SecretPromptError::SpawnFailure {
                action: request_action,
                message: error.to_string(),
            })?
            .set_raw_out(true)
            .args(["--action", request_action.as_cli_arg()]);

        let (mut rx, mut child) =
            sidecar_command
                .spawn()
                .map_err(|error| SecretPromptError::SpawnFailure {
                    action: request_action,
                    message: error.to_string(),
                })?;

        {
            let mut payload = Zeroizing::new(request_payload);
            payload.push(b'\n');
            if let Err(error) = child.write(&payload) {
                let _ = child.kill();
                drain_prompt_events(&mut rx).await;
                return Err(SecretPromptError::StdinFailure {
                    action: request_action,
                    message: error.to_string(),
                });
            }
        }
        let mut child = Some(child);

        let mut stdout = Zeroizing::new(Vec::<u8>::new());
        let mut stderr = Zeroizing::new(Vec::<u8>::new());
        let mut exit_code: Option<i32> = None;

        loop {
            let event = match cancellation {
                Some(cancellation) => {
                    let wait_result = {
                        let event_future = rx.recv();
                        let cancellation_future = cancellation.cancelled();
                        pin_mut!(event_future);
                        pin_mut!(cancellation_future);
                        match select(event_future, cancellation_future).await {
                            Either::Left((event, _)) => Ok(event),
                            Either::Right(((), _)) => Err(()),
                        }
                    };
                    match wait_result {
                        Ok(event) => event,
                        Err(()) => {
                            terminate_prompt_child(&mut child, &mut rx).await;
                            return Err(SecretPromptError::LifecycleCancelled {
                                action: request_action,
                            });
                        }
                    }
                }
                None => rx.recv().await,
            };
            let Some(event) = event else {
                break;
            };
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Err(error) = append_sidecar_output(
                        &mut stdout,
                        &bytes,
                        SECRET_PROMPT_MAX_RESPONSE_BYTES,
                        "stdout",
                        request_action,
                    ) {
                        terminate_prompt_child(&mut child, &mut rx).await;
                        return Err(error);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Err(error) = append_sidecar_output(
                        &mut stderr,
                        &bytes,
                        SECRET_PROMPT_MAX_STDERR_BYTES,
                        "stderr",
                        request_action,
                    ) {
                        terminate_prompt_child(&mut child, &mut rx).await;
                        return Err(error);
                    }
                }
                CommandEvent::Terminated(terminated) => {
                    exit_code = terminated.code;
                }
                CommandEvent::Error(message) => {
                    terminate_prompt_child(&mut child, &mut rx).await;
                    return Err(SecretPromptError::SpawnFailure {
                        action: request_action,
                        message,
                    });
                }
                _ => {}
            }
        }
        drop(child.take());

        let response = parse_prompt_response(&stdout, request_action)?;
        if let SecretPromptResponse::Cancelled(response) = &response {
            return Err(SecretPromptError::Cancelled {
                action: response.action,
            });
        }
        if let SecretPromptResponse::Error(response) = &response {
            return Err(SecretPromptError::HelperFailure {
                action: response.action,
                code: response.code,
                message: response.message.clone(),
            });
        }
        if response.action() != request_action {
            return Err(SecretPromptError::UnexpectedResponse {
                expected: request_action,
                received: response.action(),
            });
        }
        if exit_code.is_some_and(|code| code != 0) {
            return Err(SecretPromptError::HelperFailure {
                action: request_action,
                code: SecretPromptErrorCode::InternalFailure,
                message: sanitize_stderr(&stderr),
            });
        }

        Ok(response)
    }
}

impl SecretPromptCoordinator {
    fn reserve(
        self: &Arc<Self>,
        action: SecretPromptAction,
    ) -> Result<SecretPromptLease, SecretPromptError> {
        let mut active_action =
            self.active_action
                .lock()
                .map_err(|_| SecretPromptError::ProtocolFailure {
                    message: "Failed to lock the native wallet prompt coordinator".to_owned(),
                })?;
        if let Some(active) = *active_action {
            return Err(SecretPromptError::Busy {
                active,
                requested: action,
            });
        }
        *active_action = Some(action);
        Ok(SecretPromptLease {
            coordinator: Arc::clone(self),
            action,
        })
    }
}

impl Drop for SecretPromptLease {
    fn drop(&mut self) {
        if let Ok(mut active_action) = self.coordinator.active_action.lock()
            && *active_action == Some(self.action)
        {
            *active_action = None;
        }
    }
}

async fn terminate_prompt_child(
    child: &mut Option<CommandChild>,
    events: &mut Receiver<CommandEvent>,
) {
    if let Some(child) = child.take() {
        let _ = child.kill();
    }
    drain_prompt_events(events).await;
}

async fn drain_prompt_events(events: &mut Receiver<CommandEvent>) {
    while events.recv().await.is_some() {}
}

fn append_sidecar_output(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
    stream_name: &str,
    action: SecretPromptAction,
) -> Result<(), SecretPromptError> {
    let next_len = buffer.len().saturating_add(chunk.len());
    if next_len > max_bytes {
        return Err(SecretPromptError::ProtocolFailure {
            message: format!(
                "Secret prompt {stream_name} exceeded {max_bytes} bytes for {}",
                action.as_cli_arg()
            ),
        });
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

fn parse_prompt_response(
    raw_stdout: &[u8],
    action: SecretPromptAction,
) -> Result<SecretPromptResponse, SecretPromptError> {
    let stdout_text =
        std::str::from_utf8(raw_stdout).map_err(|error| SecretPromptError::ProtocolFailure {
            message: format!("Invalid UTF-8 in secret prompt response: {error}"),
        })?;
    let trimmed = stdout_text.trim();
    if trimmed.is_empty() {
        return Err(SecretPromptError::ProtocolFailure {
            message: format!(
                "Secret prompt produced no response for {}",
                action.as_cli_arg()
            ),
        });
    }
    serde_json::from_str(trimmed).map_err(|error| SecretPromptError::ProtocolFailure {
        message: format!("Invalid secret prompt response JSON: {error}"),
    })
}

fn sanitize_stderr(stderr: &[u8]) -> String {
    let trimmed = String::from_utf8_lossy(stderr).trim().to_owned();
    if trimmed.is_empty() {
        "Secret prompt helper failed".to_owned()
    } else {
        trimmed
    }
}

pub struct ImportPromptOutput {
    pub label: String,
    pub private_key: Zeroizing<String>,
    pub passphrase: Zeroizing<String>,
    pub passphrase_confirmation: Zeroizing<String>,
}

pub struct UnlockPromptOutput {
    pub passphrase: Zeroizing<String>,
}

pub struct RemoveConfirmPromptOutput {
    pub passphrase: Zeroizing<String>,
    pub typed_confirmation: String,
}

pub struct ExportConfirmPromptOutput {
    pub passphrase: Zeroizing<String>,
    pub typed_confirmation: String,
}

pub struct ExportRevealPromptInput {
    pub wallet_label: String,
    pub wallet_address: String,
    pub private_key: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SecretPromptError {
    #[error("Secret prompt sidecar could not start for {action:?}: {message}")]
    SpawnFailure {
        action: SecretPromptAction,
        message: String,
    },
    #[error("Secret prompt sidecar stdin write failed for {action:?}: {message}")]
    StdinFailure {
        action: SecretPromptAction,
        message: String,
    },
    #[error("Secret prompt {requested:?} was blocked by active prompt {active:?}")]
    Busy {
        active: SecretPromptAction,
        requested: SecretPromptAction,
    },
    #[error("Secret prompt was cancelled by its lifecycle owner for {action:?}")]
    LifecycleCancelled { action: SecretPromptAction },
    #[error("Secret prompt was cancelled for {action:?}")]
    Cancelled { action: SecretPromptAction },
    #[error("Secret prompt helper failed for {action:?}: {message}")]
    HelperFailure {
        action: SecretPromptAction,
        code: SecretPromptErrorCode,
        message: String,
    },
    #[error(
        "Secret prompt returned an unexpected response: expected {expected:?}, got {received:?}"
    )]
    UnexpectedResponse {
        expected: SecretPromptAction,
        received: SecretPromptAction,
    },
    #[error("Secret prompt protocol failed: {message}")]
    ProtocolFailure { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use artgod_secret_prompt_protocol::{
        ErrorSecretPromptResponse, SecretPromptResponse, UnlockSecretPromptResponse,
    };

    #[test]
    fn parse_prompt_response_accepts_valid_json() {
        let response = parse_prompt_response(
            br#"{"type":"unlock_submitted","passphrase":"top secret"}"#,
            SecretPromptAction::Unlock,
        )
        .unwrap();

        assert_eq!(
            response,
            SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
                passphrase: "top secret".to_owned(),
            })
        );
    }

    #[test]
    fn parse_prompt_response_rejects_empty_output() {
        let error = parse_prompt_response(b"   ", SecretPromptAction::Import).unwrap_err();
        assert!(matches!(error, SecretPromptError::ProtocolFailure { .. }));
    }

    #[test]
    fn sanitize_stderr_falls_back_when_empty() {
        assert_eq!(sanitize_stderr(b"   "), "Secret prompt helper failed");
    }

    #[test]
    fn helper_failure_response_roundtrip_is_expected() {
        let response = SecretPromptResponse::Error(ErrorSecretPromptResponse {
            action: SecretPromptAction::Unlock,
            code: SecretPromptErrorCode::UiUnavailable,
            message: "No dialog backend".to_owned(),
        });
        let raw = serde_json::to_vec(&response).unwrap();
        let parsed = parse_prompt_response(&raw, SecretPromptAction::Unlock).unwrap();
        assert_eq!(parsed, response);
    }

    #[test]
    fn append_sidecar_output_rejects_oversized_chunks() {
        let mut buffer = Vec::from([1_u8, 2_u8, 3_u8]);
        let error = append_sidecar_output(
            &mut buffer,
            &[4, 5],
            4,
            "stdout",
            SecretPromptAction::Import,
        )
        .unwrap_err();
        assert!(matches!(error, SecretPromptError::ProtocolFailure { .. }));
        assert_eq!(buffer, vec![1_u8, 2_u8, 3_u8]);
    }

    #[test]
    fn cloned_sidecars_share_one_global_prompt_slot() {
        let sidecar = SecretPromptSidecar::new();
        let clone = sidecar.clone();
        let lease = sidecar
            .coordinator
            .reserve(SecretPromptAction::Unlock)
            .unwrap();

        let error = clone
            .coordinator
            .reserve(SecretPromptAction::Import)
            .err()
            .expect("second prompt should be rejected");

        assert!(matches!(
            error,
            SecretPromptError::Busy {
                active: SecretPromptAction::Unlock,
                requested: SecretPromptAction::Import,
            }
        ));
        drop(lease);
        assert!(
            clone
                .coordinator
                .reserve(SecretPromptAction::Import)
                .is_ok()
        );
    }
}
