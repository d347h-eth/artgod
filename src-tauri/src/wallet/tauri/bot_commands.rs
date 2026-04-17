use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::desktop_log::append_desktop_log;
use crate::runtime::{
    BotCriticalDependencyStatus, BotRuntimeSnapshot, BotRuntimeState, DesktopRuntimeConfig,
    DesktopWalletConfig, RuntimeManager, bot_runtime_spec, build_trading_secret_envelope,
};
use crate::wallet::application::use_cases::{
    AssignWalletToBot, AssignWalletToBotError, AssignWalletToBotInput, UnlockWalletForBotStart,
    UnlockWalletForBotStartError, UnlockWalletForBotStartInput,
};
use crate::wallet::domain::{BotKind, PassphrasePolicy, WalletMetadata, WalletStatus};
use crate::wallet::infra::keystore::AlloyKeystore;
use crate::wallet::infra::prompt::{SecretPromptError, SecretPromptSidecar};
use crate::wallet::infra::storage::FsWalletStore;

use super::WalletCommandState;
use crate::DesktopState;

/// Tauri-managed bot command state for wallet-bound runtime control.
#[derive(Clone)]
pub struct BotCommandState {
    store: Arc<FsWalletStore>,
    keystore: Arc<AlloyKeystore>,
    passphrase_policy: PassphrasePolicy,
    prompt: SecretPromptSidecar,
    bot_unlock_stabilization_delay_ms: u64,
}

impl BotCommandState {
    /// Loads the bot command state from desktop app-data config.
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let wallet_state = WalletCommandState::load(app)?;
        let wallet_config = DesktopWalletConfig::load_or_create(app)?;
        Ok(Self {
            store: wallet_state.store().clone(),
            keystore: wallet_state.keystore().clone(),
            passphrase_policy: wallet_state.passphrase_policy().clone(),
            prompt: wallet_state.prompt().clone(),
            bot_unlock_stabilization_delay_ms: wallet_config.bot_unlock_stabilization_delay_ms,
        })
    }

    fn assign_wallet_use_case(&self) -> AssignWalletToBot {
        AssignWalletToBot::new(self.store.clone())
    }

    fn unlock_wallet_use_case(&self) -> UnlockWalletForBotStart {
        UnlockWalletForBotStart::new(
            self.store.clone(),
            self.keystore.clone(),
            self.passphrase_policy.clone(),
        )
    }

    fn list_bots(&self, runtime: &RuntimeManager) -> Result<Vec<BotRuntimeDto>, String> {
        let wallets = self
            .store
            .list_wallets()
            .map_err(|error| format!("Wallet metadata could not be loaded: {error}"))?;
        let runtime_snapshots = runtime.list_bot_runtime_snapshots()?;
        Ok(runtime_snapshots
            .iter()
            .map(|snapshot| self.to_bot_runtime_dto(snapshot, &wallets))
            .collect())
    }

    fn assign_wallet(
        &self,
        app: &AppHandle,
        runtime: &RuntimeManager,
        bot_kind: BotKind,
        wallet_id: Option<String>,
    ) -> Result<BotRuntimeDto, String> {
        let snapshot = runtime.bot_runtime_state(bot_kind)?;
        if snapshot.as_ref().is_some_and(is_bot_runtime_busy) {
            return Err("Stop the bot before changing its wallet assignment.".to_owned());
        }

        self.assign_wallet_use_case()
            .execute(AssignWalletToBotInput {
                bot_kind,
                wallet_id,
            })
            .map_err(|error| {
                append_desktop_log(
                    app,
                    "error",
                    &format!("Bot wallet assignment failed: {error}"),
                );
                sanitize_assign_wallet_error(error)
            })?;

        let _ = runtime.clear_bot_runtime_state(app, bot_kind);
        let snapshot = runtime
            .bot_runtime_state(bot_kind)?
            .ok_or_else(|| "Bot runtime snapshot is unavailable.".to_owned())?;
        let wallets = self
            .store
            .list_wallets()
            .map_err(|error| format!("Wallet metadata could not be loaded: {error}"))?;
        Ok(self.to_bot_runtime_dto(&snapshot, &wallets))
    }

    async fn start_bot(
        &self,
        app: &AppHandle,
        runtime: &RuntimeManager,
        bot_kind: BotKind,
    ) -> Result<BotRuntimeDto, String> {
        let wallets = self
            .store
            .list_wallets()
            .map_err(|error| format!("Wallet metadata could not be loaded: {error}"))?;
        let assigned_wallet = wallets
            .iter()
            .find(|wallet| wallet.is_assigned_to_bot(bot_kind))
            .cloned()
            .ok_or_else(|| "Assign a wallet to this bot before starting it.".to_owned())?;

        let current_snapshot = runtime
            .bot_runtime_state(bot_kind)?
            .ok_or_else(|| "Bot runtime snapshot is unavailable.".to_owned())?;
        if is_bot_runtime_busy(&current_snapshot) {
            return Err("Bot is already active.".to_owned());
        }

        runtime
            .wait_until_bot_dependencies_stable(bot_kind, self.bot_unlock_stabilization_delay_ms)?;
        runtime.set_bot_runtime_state(app, bot_kind, BotRuntimeState::AwaitingUnlock, None)?;

        let prompt_output = match self
            .prompt
            .request_unlock(
                app,
                assigned_wallet.label.as_str().to_owned(),
                assigned_wallet.address.as_str().to_owned(),
                bot_runtime_spec(bot_kind).startup_reason.to_owned(),
            )
            .await
        {
            Ok(output) => output,
            Err(SecretPromptError::Cancelled { .. }) => {
                append_desktop_log(
                    app,
                    "info",
                    &format!("{bot_kind:?} bot unlock prompt cancelled"),
                );
                runtime.set_bot_runtime_state(app, bot_kind, BotRuntimeState::Locked, None)?;
                return self.get_bot_runtime_dto(runtime, bot_kind);
            }
            Err(error) => {
                append_desktop_log(app, "error", &format!("Bot unlock prompt failed: {error}"));
                runtime.set_bot_runtime_state(
                    app,
                    bot_kind,
                    BotRuntimeState::Error,
                    Some(sanitize_prompt_error(&error)),
                )?;
                return Err(sanitize_prompt_error(&error));
            }
        };

        let unlocked_wallet = self
            .unlock_wallet_use_case()
            .execute(UnlockWalletForBotStartInput {
                wallet_id: assigned_wallet.wallet_id,
                bot_kind,
                passphrase: prompt_output.passphrase,
            })
            .map_err(|error| {
                append_desktop_log(app, "error", &format!("Bot wallet unlock failed: {error}"));
                let message = sanitize_unlock_wallet_error(error);
                let _ = runtime.set_bot_runtime_state(
                    app,
                    bot_kind,
                    BotRuntimeState::Error,
                    Some(message.clone()),
                );
                message
            })?;

        let secret_envelope = build_trading_secret_envelope(
            &unlocked_wallet.metadata.wallet_id,
            unlocked_wallet.metadata.address.as_str(),
            bot_kind,
            DesktopRuntimeConfig::load_or_create(app)?.chain_id,
            &unlocked_wallet.private_key,
        )
        .map_err(|error| {
            append_desktop_log(
                app,
                "error",
                &format!("Trading secret envelope build failed: {error}"),
            );
            let _ = runtime.set_bot_runtime_state(
                app,
                bot_kind,
                BotRuntimeState::Error,
                Some("Trading bot secret handoff failed.".to_owned()),
            );
            "Trading bot secret handoff failed.".to_owned()
        })?;

        runtime.set_bot_runtime_state(app, bot_kind, BotRuntimeState::Starting, None)?;
        runtime
            .start_bot_runtime(app.clone(), bot_kind, secret_envelope)
            .map_err(|error| {
                append_desktop_log(app, "error", &format!("Trading bot start failed: {error}"));
                let _ = runtime.set_bot_runtime_state(
                    app,
                    bot_kind,
                    BotRuntimeState::Error,
                    Some("Trading bot failed to start. See desktop-app logs.".to_owned()),
                );
                "Trading bot failed to start. See desktop-app logs.".to_owned()
            })?;

        self.get_bot_runtime_dto(runtime, bot_kind)
    }

    fn stop_bot(
        &self,
        app: &AppHandle,
        runtime: &RuntimeManager,
        bot_kind: BotKind,
    ) -> Result<BotRuntimeDto, String> {
        runtime.stop_bot_runtime(app, bot_kind)?;
        self.get_bot_runtime_dto(runtime, bot_kind)
    }

    fn get_bot_runtime_dto(
        &self,
        runtime: &RuntimeManager,
        bot_kind: BotKind,
    ) -> Result<BotRuntimeDto, String> {
        let wallets = self
            .store
            .list_wallets()
            .map_err(|error| format!("Wallet metadata could not be loaded: {error}"))?;
        let snapshot = runtime
            .bot_runtime_state(bot_kind)?
            .ok_or_else(|| "Bot runtime snapshot is unavailable.".to_owned())?;
        Ok(self.to_bot_runtime_dto(&snapshot, &wallets))
    }

    fn to_bot_runtime_dto(
        &self,
        snapshot: &BotRuntimeSnapshot,
        wallets: &[WalletMetadata],
    ) -> BotRuntimeDto {
        let assigned_wallet = wallets
            .iter()
            .find(|wallet| wallet.is_assigned_to_bot(snapshot.bot_kind))
            .map(BotAssignedWalletDto::from_metadata);

        BotRuntimeDto {
            bot_kind: BotKindDto::from_domain(snapshot.bot_kind),
            process_name: snapshot.process_name.clone(),
            state: BotRuntimeStateDto::from_runtime_state(
                snapshot.state,
                assigned_wallet.is_some(),
            ),
            last_error: snapshot.last_error.clone(),
            critical_dependencies: snapshot
                .critical_dependencies
                .iter()
                .map(BotCriticalDependencyStatusDto::from_runtime)
                .collect(),
            assigned_wallet,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BotKindDto {
    Bidding,
    Sniping,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BotRuntimeStateDto {
    Disabled,
    Locked,
    AwaitingUnlock,
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotAssignedWalletDto {
    wallet_id: String,
    label: String,
    address: String,
    status: WalletStatusDto,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletStatusDto {
    Stored,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCriticalDependencyStatusDto {
    process: String,
    healthy: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeDto {
    bot_kind: BotKindDto,
    process_name: String,
    state: BotRuntimeStateDto,
    last_error: Option<String>,
    critical_dependencies: Vec<BotCriticalDependencyStatusDto>,
    assigned_wallet: Option<BotAssignedWalletDto>,
}

impl BotKindDto {
    fn into_domain(self) -> BotKind {
        match self {
            Self::Bidding => BotKind::Bidding,
            Self::Sniping => BotKind::Sniping,
        }
    }

    fn from_domain(bot_kind: BotKind) -> Self {
        match bot_kind {
            BotKind::Bidding => Self::Bidding,
            BotKind::Sniping => Self::Sniping,
        }
    }
}

impl BotRuntimeStateDto {
    fn from_runtime_state(state: BotRuntimeState, has_assignment: bool) -> Self {
        match state {
            BotRuntimeState::Disabled if has_assignment => Self::Locked,
            BotRuntimeState::Disabled => Self::Disabled,
            BotRuntimeState::Locked => Self::Locked,
            BotRuntimeState::AwaitingUnlock => Self::AwaitingUnlock,
            BotRuntimeState::Starting => Self::Starting,
            BotRuntimeState::Running => Self::Running,
            BotRuntimeState::Stopped => Self::Stopped,
            BotRuntimeState::Error => Self::Error,
        }
    }
}

impl BotAssignedWalletDto {
    fn from_metadata(metadata: &WalletMetadata) -> Self {
        Self {
            wallet_id: metadata.wallet_id.as_str().to_owned(),
            label: metadata.label.as_str().to_owned(),
            address: metadata.address.as_str().to_owned(),
            status: WalletStatusDto::from_domain(metadata.status),
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

impl BotCriticalDependencyStatusDto {
    fn from_runtime(status: &BotCriticalDependencyStatus) -> Self {
        Self {
            process: status.process.clone(),
            healthy: status.healthy,
        }
    }
}

fn is_bot_runtime_busy(snapshot: &BotRuntimeSnapshot) -> bool {
    matches!(
        snapshot.state,
        BotRuntimeState::AwaitingUnlock | BotRuntimeState::Starting | BotRuntimeState::Running
    )
}

fn sanitize_assign_wallet_error(error: AssignWalletToBotError) -> String {
    match error {
        AssignWalletToBotError::InvalidWalletId(_) => "Wallet identifier is invalid.".to_owned(),
        AssignWalletToBotError::WalletNotFound { .. } => "Wallet does not exist.".to_owned(),
        AssignWalletToBotError::StorageFailure { .. } => {
            "Wallet assignment could not be updated. See desktop-app logs.".to_owned()
        }
    }
}

fn sanitize_unlock_wallet_error(error: UnlockWalletForBotStartError) -> String {
    match error {
        UnlockWalletForBotStartError::InvalidPassphraseInput(error) => error.to_string(),
        UnlockWalletForBotStartError::WalletNotFound { .. } => "Wallet does not exist.".to_owned(),
        UnlockWalletForBotStartError::UnlockRejected => {
            "Wallet passphrase was rejected or the keystore is unreadable.".to_owned()
        }
        UnlockWalletForBotStartError::StorageFailure { .. } => {
            "Wallet metadata could not be loaded. See desktop-app logs.".to_owned()
        }
    }
}

fn sanitize_prompt_error(error: &SecretPromptError) -> String {
    match error {
        SecretPromptError::SpawnFailure { .. } | SecretPromptError::StdinFailure { .. } => {
            "Native wallet prompt is unavailable. See desktop-app logs.".to_owned()
        }
        SecretPromptError::HelperFailure { .. }
        | SecretPromptError::UnexpectedResponse { .. }
        | SecretPromptError::ProtocolFailure { .. } => {
            "Native wallet prompt failed. See desktop-app logs.".to_owned()
        }
        SecretPromptError::Cancelled { .. } => "Wallet prompt was cancelled.".to_owned(),
    }
}

#[tauri::command]
pub fn bot_list(
    desktop: State<'_, DesktopState>,
    state: State<'_, BotCommandState>,
) -> Result<Vec<BotRuntimeDto>, String> {
    state.list_bots(&desktop.runtime)
}

#[tauri::command]
pub fn bot_assign_wallet(
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    state: State<'_, BotCommandState>,
    bot_kind: BotKindDto,
    wallet_id: Option<String>,
) -> Result<BotRuntimeDto, String> {
    state.assign_wallet(&app, &desktop.runtime, bot_kind.into_domain(), wallet_id)
}

#[tauri::command]
pub async fn bot_start(
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    state: State<'_, BotCommandState>,
    bot_kind: BotKindDto,
) -> Result<BotRuntimeDto, String> {
    let command_state = state.inner().clone();
    command_state
        .start_bot(&app, &desktop.runtime, bot_kind.into_domain())
        .await
}

#[tauri::command]
pub fn bot_stop(
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    state: State<'_, BotCommandState>,
    bot_kind: BotKindDto,
) -> Result<BotRuntimeDto, String> {
    state.stop_bot(&app, &desktop.runtime, bot_kind.into_domain())
}
