use std::sync::Arc;

use alloy_primitives::hex;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::desktop_log::append_desktop_log;
use crate::runtime::DesktopWalletConfig;
use crate::wallet::application::use_cases::{
    ExportWallet, ExportWalletError, ExportWalletInput, ImportWallet, ImportWalletError,
    ImportWalletInput, ListWallets, ListWalletsError, RemoveWallet, RemoveWalletError,
    RemoveWalletInput,
};
use crate::wallet::domain::{BotKind, PassphrasePolicy, WalletId, WalletMetadata, WalletStatus};
use crate::wallet::infra::keystore::AlloyKeystore;
use crate::wallet::infra::prompt::SecretPromptError;
use crate::wallet::infra::prompt::SecretPromptSidecar;
use crate::wallet::infra::storage::FsWalletStore;

/// Tauri-managed wallet command state for the privileged admin UI.
#[derive(Clone)]
pub struct WalletCommandState {
    store: Arc<FsWalletStore>,
    keystore: Arc<AlloyKeystore>,
    passphrase_policy: PassphrasePolicy,
    prompt: SecretPromptSidecar,
}

impl WalletCommandState {
    /// Loads the wallet command state from desktop app-data config.
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let config = DesktopWalletConfig::load_or_create(app)?;
        let store = Arc::new(
            FsWalletStore::new_with_paths(config.store_dir, config.index_path)
                .map_err(|error| format!("Failed to initialize wallet store: {error}"))?,
        );
        Ok(Self {
            store,
            keystore: Arc::new(AlloyKeystore),
            passphrase_policy: PassphrasePolicy::default(),
            prompt: SecretPromptSidecar::new(),
        })
    }

    fn list_wallets_use_case(&self) -> ListWallets {
        ListWallets::new(self.store.clone())
    }

    fn import_wallet_use_case(&self) -> ImportWallet {
        ImportWallet::new(
            self.store.clone(),
            self.keystore.clone(),
            self.passphrase_policy.clone(),
        )
    }

    fn remove_wallet_use_case(&self) -> RemoveWallet {
        RemoveWallet::new(
            self.store.clone(),
            self.keystore.clone(),
            self.passphrase_policy.clone(),
        )
    }

    fn export_wallet_use_case(&self) -> ExportWallet {
        ExportWallet::new(
            self.store.clone(),
            self.keystore.clone(),
            self.passphrase_policy.clone(),
        )
    }

    pub(crate) fn store(&self) -> &Arc<FsWalletStore> {
        &self.store
    }

    pub(crate) fn keystore(&self) -> &Arc<AlloyKeystore> {
        &self.keystore
    }

    pub(crate) fn passphrase_policy(&self) -> &PassphrasePolicy {
        &self.passphrase_policy
    }

    pub(crate) fn prompt(&self) -> &SecretPromptSidecar {
        &self.prompt
    }

    fn list_wallet_dtos(&self) -> Result<Vec<WalletMetadataDto>, String> {
        self.list_wallets_use_case()
            .execute()
            .map(|output| {
                output
                    .wallets
                    .iter()
                    .map(WalletMetadataDto::from_metadata)
                    .collect()
            })
            .map_err(sanitize_list_wallets_error)
    }

    fn wallet_status(&self) -> Result<WalletCommandStatusDto, String> {
        self.list_wallets_use_case()
            .execute()
            .map(|output| WalletCommandStatusDto {
                configured_wallet_count: output.wallets.len(),
                supported_actions: supported_wallet_actions(),
                custody_boundary: WalletCustodyBoundaryDto::NativePrompt,
            })
            .map_err(sanitize_list_wallets_error)
    }

    async fn import_wallet(&self, app: &AppHandle) -> Result<WalletImportCommandResultDto, String> {
        let prompt_output = match self
            .prompt
            .request_import(app, None, self.passphrase_policy.min_length())
            .await
        {
            Ok(output) => output,
            Err(SecretPromptError::Cancelled { .. }) => {
                append_desktop_log(app, "info", "Wallet import prompt cancelled");
                return Ok(WalletImportCommandResultDto::Cancelled);
            }
            Err(error) => {
                log_wallet_error(app, "Wallet import prompt failed", &error);
                return Err(sanitize_prompt_error(error));
            }
        };

        self.import_wallet_use_case()
            .execute(ImportWalletInput {
                label: prompt_output.label,
                private_key: prompt_output.private_key,
                passphrase: prompt_output.passphrase,
                passphrase_confirmation: prompt_output.passphrase_confirmation,
            })
            .map(|wallet| WalletImportCommandResultDto::Imported {
                wallet: WalletMetadataDto::from_metadata(&wallet),
            })
            .map_err(|error| {
                log_wallet_error(app, "Wallet import failed", &error);
                sanitize_import_wallet_error(error)
            })
    }

    async fn remove_wallet(
        &self,
        app: &AppHandle,
        wallet_id: &str,
    ) -> Result<WalletRemoveCommandResultDto, String> {
        let wallet_id =
            WalletId::parse(wallet_id).map_err(|_| "Wallet identifier is invalid.".to_owned())?;
        let wallet_record = self.store.get_wallet_record(&wallet_id).map_err(|error| {
            append_desktop_log(
                app,
                "error",
                &format!("Wallet remove lookup failed: {error}"),
            );
            sanitize_remove_lookup_error(&error.to_string())
        })?;
        if wallet_record.metadata.has_bot_assignment() {
            return Err("Unassign this wallet from all bots before removing it.".to_owned());
        }

        let prompt_output = match self
            .prompt
            .request_remove_confirmation(
                app,
                wallet_record.metadata.label.as_str().to_owned(),
                wallet_record.metadata.address.as_str().to_owned(),
                remove_confirmation_phrase(wallet_record.metadata.address.as_str()),
            )
            .await
        {
            Ok(output) => output,
            Err(SecretPromptError::Cancelled { .. }) => {
                append_desktop_log(app, "info", "Wallet remove prompt cancelled");
                return Ok(WalletRemoveCommandResultDto::Cancelled);
            }
            Err(error) => {
                log_wallet_error(app, "Wallet remove prompt failed", &error);
                return Err(sanitize_prompt_error(error));
            }
        };
        let expected_confirmation =
            remove_confirmation_phrase(wallet_record.metadata.address.as_str());
        if prompt_output.typed_confirmation != expected_confirmation {
            append_desktop_log(app, "warn", "Wallet remove confirmation phrase mismatch");
            return Err(format!("Type {expected_confirmation} exactly to continue."));
        }

        self.remove_wallet_use_case()
            .execute(RemoveWalletInput {
                wallet_id,
                passphrase: prompt_output.passphrase,
            })
            .map(|wallet| WalletRemoveCommandResultDto::Removed {
                wallet: WalletMetadataDto::from_metadata(&wallet),
            })
            .map_err(|error| {
                log_wallet_error(app, "Wallet remove failed", &error);
                sanitize_remove_wallet_error(error)
            })
    }

    async fn export_wallet(
        &self,
        app: &AppHandle,
        wallet_id: &str,
    ) -> Result<WalletExportCommandResultDto, String> {
        let wallet_id =
            WalletId::parse(wallet_id).map_err(|_| "Wallet identifier is invalid.".to_owned())?;
        let wallet_record = self.store.get_wallet_record(&wallet_id).map_err(|error| {
            append_desktop_log(
                app,
                "error",
                &format!("Wallet export lookup failed: {error}"),
            );
            sanitize_export_lookup_error(&error.to_string())
        })?;

        let prompt_output = match self
            .prompt
            .request_export_confirmation(
                app,
                wallet_record.metadata.label.as_str().to_owned(),
                wallet_record.metadata.address.as_str().to_owned(),
                export_confirmation_token().to_owned(),
            )
            .await
        {
            Ok(output) => output,
            Err(SecretPromptError::Cancelled { .. }) => {
                append_desktop_log(app, "info", "Wallet export prompt cancelled");
                return Ok(WalletExportCommandResultDto::Cancelled);
            }
            Err(error) => {
                log_wallet_error(app, "Wallet export prompt failed", &error);
                return Err(sanitize_prompt_error(error));
            }
        };
        if prompt_output.typed_confirmation != export_confirmation_token() {
            append_desktop_log(app, "warn", "Wallet export confirmation token mismatch");
            return Err(format!(
                "Type {} exactly to continue.",
                export_confirmation_token()
            ));
        }

        let exported_wallet = self
            .export_wallet_use_case()
            .execute(ExportWalletInput {
                wallet_id,
                passphrase: prompt_output.passphrase,
            })
            .map_err(|error| {
                log_wallet_error(app, "Wallet export failed", &error);
                sanitize_export_wallet_error(error)
            })?;

        let private_key = format!("0x{}", hex::encode(exported_wallet.private_key.as_bytes()));
        self.prompt
            .reveal_exported_private_key(
                app,
                crate::wallet::infra::prompt::ExportRevealPromptInput {
                    wallet_label: exported_wallet.metadata.label.as_str().to_owned(),
                    wallet_address: exported_wallet.metadata.address.as_str().to_owned(),
                    private_key,
                },
            )
            .await
            .map_err(|error| {
                log_wallet_error(app, "Wallet export reveal failed", &error);
                sanitize_prompt_error(error)
            })?;

        Ok(WalletExportCommandResultDto::Revealed {
            wallet: WalletMetadataDto::from_metadata(&exported_wallet.metadata),
        })
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletCommandActionDto {
    Import,
    Export,
    Remove,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletCustodyBoundaryDto {
    NativePrompt,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletBotKindDto {
    Bidding,
    Sniping,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletStatusDto {
    Stored,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletMetadataDto {
    wallet_id: String,
    label: String,
    address: String,
    assigned_bot_kinds: Vec<WalletBotKindDto>,
    status: WalletStatusDto,
}

impl WalletMetadataDto {
    fn from_metadata(metadata: &WalletMetadata) -> Self {
        Self {
            wallet_id: metadata.wallet_id.as_str().to_owned(),
            label: metadata.label.as_str().to_owned(),
            address: metadata.address.as_str().to_owned(),
            assigned_bot_kinds: metadata
                .assigned_bot_kinds
                .iter()
                .copied()
                .map(WalletBotKindDto::from_domain)
                .collect(),
            status: WalletStatusDto::from_domain(metadata.status),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletCommandStatusDto {
    configured_wallet_count: usize,
    supported_actions: Vec<WalletCommandActionDto>,
    custody_boundary: WalletCustodyBoundaryDto,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum WalletImportCommandResultDto {
    Imported { wallet: WalletMetadataDto },
    Cancelled,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum WalletRemoveCommandResultDto {
    Removed { wallet: WalletMetadataDto },
    Cancelled,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum WalletExportCommandResultDto {
    Revealed { wallet: WalletMetadataDto },
    Cancelled,
}

impl WalletBotKindDto {
    fn from_domain(bot_kind: BotKind) -> Self {
        match bot_kind {
            BotKind::Bidding => Self::Bidding,
            BotKind::Sniping => Self::Sniping,
        }
    }
}

impl WalletStatusDto {
    fn from_domain(status: WalletStatus) -> Self {
        match status {
            WalletStatus::Stored => Self::Stored,
        }
    }
}

fn supported_wallet_actions() -> Vec<WalletCommandActionDto> {
    vec![
        WalletCommandActionDto::Import,
        WalletCommandActionDto::Export,
        WalletCommandActionDto::Remove,
    ]
}

fn remove_confirmation_phrase(wallet_address: &str) -> String {
    wallet_address
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn export_confirmation_token() -> &'static str {
    "EXPORT"
}

fn sanitize_list_wallets_error(_: ListWalletsError) -> String {
    "Wallet metadata could not be loaded. Check the desktop logs.".to_owned()
}

fn sanitize_import_wallet_error(error: ImportWalletError) -> String {
    match error {
        ImportWalletError::InvalidLabel(error) => error.to_string(),
        ImportWalletError::InvalidPassphrase(error) => error.to_string(),
        ImportWalletError::InvalidPrivateKey => "Wallet private key is invalid.".to_owned(),
        ImportWalletError::DuplicateLabel { label } => {
            format!("Wallet label already exists: {label}")
        }
        ImportWalletError::DuplicateAddress { address } => {
            format!("Wallet address already exists: {address}")
        }
        ImportWalletError::StorageFailure { .. } => {
            "Wallet metadata could not be updated. Check the desktop logs.".to_owned()
        }
        ImportWalletError::KeystoreFailure { .. } => {
            "Wallet keystore could not be written. Check the desktop logs.".to_owned()
        }
    }
}

fn sanitize_remove_lookup_error(_: &str) -> String {
    "Wallet does not exist.".to_owned()
}

fn sanitize_export_lookup_error(_: &str) -> String {
    "Wallet does not exist.".to_owned()
}

fn sanitize_remove_wallet_error(error: RemoveWalletError) -> String {
    match error {
        RemoveWalletError::InvalidPassphraseInput(error) => error.to_string(),
        RemoveWalletError::WalletNotFound { .. } => "Wallet does not exist.".to_owned(),
        RemoveWalletError::UnlockRejected => {
            "Wallet passphrase was rejected or the keystore is unreadable.".to_owned()
        }
        RemoveWalletError::StorageFailure { .. } => {
            "Wallet metadata could not be updated. Check the desktop logs.".to_owned()
        }
    }
}

fn sanitize_export_wallet_error(error: ExportWalletError) -> String {
    match error {
        ExportWalletError::InvalidPassphraseInput(error) => error.to_string(),
        ExportWalletError::WalletNotFound { .. } => "Wallet does not exist.".to_owned(),
        ExportWalletError::UnlockRejected => {
            "Wallet passphrase was rejected or the keystore is unreadable.".to_owned()
        }
        ExportWalletError::StorageFailure { .. } => {
            "Wallet metadata could not be loaded. Check the desktop logs.".to_owned()
        }
    }
}

fn sanitize_prompt_error(error: SecretPromptError) -> String {
    match error {
        SecretPromptError::SpawnFailure { .. } | SecretPromptError::StdinFailure { .. } => {
            "Native wallet prompt is unavailable. See desktop-app logs.".to_owned()
        }
        SecretPromptError::HelperFailure { .. }
        | SecretPromptError::UnexpectedResponse { .. }
        | SecretPromptError::ProtocolFailure { .. } => {
            "Native wallet prompt failed. See desktop-app logs.".to_owned()
        }
        SecretPromptError::Busy { .. } => {
            "Finish or cancel the current wallet prompt before opening another one.".to_owned()
        }
        SecretPromptError::LifecycleCancelled { .. } => "Wallet prompt was cancelled.".to_owned(),
        SecretPromptError::Cancelled { .. } => "Wallet prompt was cancelled.".to_owned(),
    }
}

fn log_wallet_error(app: &AppHandle, context: &str, error: &impl std::fmt::Display) {
    append_desktop_log(app, "error", &format!("{context}: {error}"));
}

#[tauri::command]
pub fn wallet_list(state: State<'_, WalletCommandState>) -> Result<Vec<WalletMetadataDto>, String> {
    state.list_wallet_dtos()
}

#[tauri::command]
pub fn wallet_get_status(
    state: State<'_, WalletCommandState>,
) -> Result<WalletCommandStatusDto, String> {
    state.wallet_status()
}

#[tauri::command]
pub async fn wallet_import(
    app: AppHandle,
    state: State<'_, WalletCommandState>,
) -> Result<WalletImportCommandResultDto, String> {
    let command_state = state.inner().clone();
    command_state.import_wallet(&app).await
}

#[tauri::command]
pub async fn wallet_remove(
    app: AppHandle,
    state: State<'_, WalletCommandState>,
    wallet_id: String,
) -> Result<WalletRemoveCommandResultDto, String> {
    let command_state = state.inner().clone();
    command_state.remove_wallet(&app, &wallet_id).await
}

#[tauri::command]
pub async fn wallet_export(
    app: AppHandle,
    state: State<'_, WalletCommandState>,
    wallet_id: String,
) -> Result<WalletExportCommandResultDto, String> {
    let command_state = state.inner().clone();
    command_state.export_wallet(&app, &wallet_id).await
}
