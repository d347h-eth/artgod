use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretPromptAction {
    Import,
    Unlock,
    RemoveConfirm,
    ExportConfirm,
    ExportReveal,
}

impl SecretPromptAction {
    pub fn as_cli_arg(self) -> &'static str {
        match self {
            Self::Import => "import",
            Self::Unlock => "unlock",
            Self::RemoveConfirm => "remove-confirm",
            Self::ExportConfirm => "export-confirm",
            Self::ExportReveal => "export-reveal",
        }
    }

    pub fn parse_cli_arg(raw: &str) -> Option<Self> {
        match raw.trim() {
            "import" => Some(Self::Import),
            "unlock" => Some(Self::Unlock),
            "remove-confirm" => Some(Self::RemoveConfirm),
            "export-confirm" => Some(Self::ExportConfirm),
            "export-reveal" => Some(Self::ExportReveal),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SecretPromptRequest {
    Import(ImportSecretPromptRequest),
    Unlock(UnlockSecretPromptRequest),
    RemoveConfirm(RemoveConfirmSecretPromptRequest),
    ExportConfirm(ExportConfirmSecretPromptRequest),
    ExportReveal(ExportRevealSecretPromptRequest),
}

impl SecretPromptRequest {
    pub fn action(&self) -> SecretPromptAction {
        match self {
            Self::Import(_) => SecretPromptAction::Import,
            Self::Unlock(_) => SecretPromptAction::Unlock,
            Self::RemoveConfirm(_) => SecretPromptAction::RemoveConfirm,
            Self::ExportConfirm(_) => SecretPromptAction::ExportConfirm,
            Self::ExportReveal(_) => SecretPromptAction::ExportReveal,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SecretPromptResponse {
    ImportSubmitted(ImportSecretPromptResponse),
    UnlockSubmitted(UnlockSecretPromptResponse),
    RemoveConfirmSubmitted(RemoveConfirmSecretPromptResponse),
    ExportConfirmSubmitted(ExportConfirmSecretPromptResponse),
    ExportRevealAcknowledged(ExportRevealAcknowledgedResponse),
    Cancelled(CancelledSecretPromptResponse),
    Error(ErrorSecretPromptResponse),
}

impl SecretPromptResponse {
    pub fn action(&self) -> SecretPromptAction {
        match self {
            Self::ImportSubmitted(_) => SecretPromptAction::Import,
            Self::UnlockSubmitted(_) => SecretPromptAction::Unlock,
            Self::RemoveConfirmSubmitted(_) => SecretPromptAction::RemoveConfirm,
            Self::ExportConfirmSubmitted(_) => SecretPromptAction::ExportConfirm,
            Self::ExportRevealAcknowledged(_) => SecretPromptAction::ExportReveal,
            Self::Cancelled(response) => response.action,
            Self::Error(response) => response.action,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSecretPromptRequest {
    pub wallet_label_hint: Option<String>,
    #[serde(default = "default_import_passphrase_min_length")]
    pub passphrase_min_length: usize,
}

fn default_import_passphrase_min_length() -> usize {
    12
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockSecretPromptRequest {
    pub wallet_label: String,
    pub wallet_address: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveConfirmSecretPromptRequest {
    pub wallet_label: String,
    pub wallet_address: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfirmSecretPromptRequest {
    pub wallet_label: String,
    pub wallet_address: String,
    pub expected_confirmation: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRevealSecretPromptRequest {
    pub wallet_label: String,
    pub wallet_address: String,
    pub private_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSecretPromptResponse {
    pub label: String,
    pub private_key: String,
    pub passphrase: String,
    pub passphrase_confirmation: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockSecretPromptResponse {
    pub passphrase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveConfirmSecretPromptResponse {
    pub passphrase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfirmSecretPromptResponse {
    pub passphrase: String,
    pub typed_confirmation: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRevealAcknowledgedResponse {
    pub acknowledged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelledSecretPromptResponse {
    pub action: SecretPromptAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretPromptErrorCode {
    InvalidRequest,
    ActionMismatch,
    UiUnavailable,
    InternalFailure,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorSecretPromptResponse {
    pub action: SecretPromptAction,
    pub code: SecretPromptErrorCode,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_action_roundtrip_is_stable() {
        for action in [
            SecretPromptAction::Import,
            SecretPromptAction::Unlock,
            SecretPromptAction::RemoveConfirm,
            SecretPromptAction::ExportConfirm,
            SecretPromptAction::ExportReveal,
        ] {
            let raw = action.as_cli_arg();
            assert_eq!(SecretPromptAction::parse_cli_arg(raw), Some(action));
        }
    }

    #[test]
    fn request_and_response_serialization_roundtrip() {
        let request = SecretPromptRequest::Unlock(UnlockSecretPromptRequest {
            wallet_label: "Primary".to_owned(),
            wallet_address: "0x123".to_owned(),
            reason: "start bidding bot".to_owned(),
        });
        let request_json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<SecretPromptRequest>(&request_json).unwrap(),
            request
        );

        let response = SecretPromptResponse::UnlockSubmitted(UnlockSecretPromptResponse {
            passphrase: "secret passphrase".to_owned(),
        });
        let response_json = serde_json::to_string(&response).unwrap();
        assert_eq!(
            serde_json::from_str::<SecretPromptResponse>(&response_json).unwrap(),
            response
        );
    }

    #[test]
    fn import_request_defaults_passphrase_min_length_for_older_payloads() {
        let request = serde_json::from_str::<SecretPromptRequest>(
            r#"{"type":"import","walletLabelHint":"Primary"}"#,
        )
        .unwrap();
        assert_eq!(
            request,
            SecretPromptRequest::Import(ImportSecretPromptRequest {
                wallet_label_hint: Some("Primary".to_owned()),
                passphrase_min_length: 12,
            })
        );
    }
}
