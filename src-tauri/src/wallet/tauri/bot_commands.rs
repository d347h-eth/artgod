use std::sync::Arc;

use artgod_secret_prompt_protocol::{
    UnlockBiddingCollectionSummary, UnlockBiddingMandateSummary, UnlockBiddingTokenScopeItem,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::desktop_log::append_desktop_log;
use crate::runtime::{
    BIDDING_MANDATE_MAX_OFFER_QUANTITY, BackendCollectionCatalog, BackendCollectionCatalogError,
    BiddingChainIdentity, BiddingCollectionCandidate, BiddingCollectionCatalog,
    BiddingCollectionMandate, BiddingCollectionMandateDraft, BiddingCollectionTokenScopeSummary,
    BiddingMandate, BiddingMandateDraft, BiddingStartPolicySnapshot, BotCriticalDependencyStatus,
    BotRuntimeSnapshot, BotRuntimeState, DesktopRuntimeConfig, DesktopWalletConfig, RuntimeManager,
    bot_runtime_spec, build_trading_secret_envelope, format_wei_as_eth,
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

const BIDDING_OPEN_SEA_SECRET_KEYS: &[&str] = &[
    "OPENSEA_STREAM_SECRET_KEY",
    "OPENSEA_BIDDING_SECRET_KEY",
    "OPENSEA_SNAPSHOT_SECRET_KEY",
];
const BOT_LOG_LEVEL_INFO: &str = "info";
const BOT_LOG_LEVEL_ERROR: &str = "error";

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

    fn list_bots(
        &self,
        app: &AppHandle,
        runtime: &RuntimeManager,
    ) -> Result<Vec<BotRuntimeDto>, String> {
        let wallets = self
            .store
            .list_wallets()
            .map_err(|error| format!("Wallet metadata could not be loaded: {error}"))?;
        let runtime_snapshots = runtime.list_bot_runtime_snapshots()?;
        let mut bot_dtos = Vec::with_capacity(runtime_snapshots.len());
        for snapshot in &runtime_snapshots {
            let disabled_reason = resolve_bot_disabled_reason(app, snapshot.bot_kind)?;
            bot_dtos.push(self.to_bot_runtime_dto(snapshot, &wallets, disabled_reason));
        }
        Ok(bot_dtos)
    }

    async fn load_bidding_collection_catalog(
        &self,
        app: &AppHandle,
    ) -> Result<BiddingCollectionCatalogDto, String> {
        let runtime_config = DesktopRuntimeConfig::load_or_create(app)?;
        let catalog = load_canonical_bidding_catalog(app, &runtime_config).await?;
        Ok(BiddingCollectionCatalogDto::from_domain(&catalog))
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
                    BOT_LOG_LEVEL_ERROR,
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
        let disabled_reason = resolve_bot_disabled_reason(app, bot_kind)?;
        Ok(self.to_bot_runtime_dto(&snapshot, &wallets, disabled_reason))
    }

    async fn start_bot(
        &self,
        app: &AppHandle,
        runtime: &RuntimeManager,
        bot_kind: BotKind,
        bidding_mandate_draft: Option<BiddingMandateDraftDto>,
    ) -> Result<BotRuntimeDto, String> {
        // Freeze all bot process inputs before showing the native unlock prompt.
        let runtime_config = DesktopRuntimeConfig::load_or_create(app)?;
        if let Some(reason) = resolve_bot_disabled_reason_from_config(&runtime_config, bot_kind)? {
            runtime.set_bot_runtime_state(
                app,
                bot_kind,
                BotRuntimeState::Disabled,
                Some(reason.clone()),
            )?;
            return Err(reason);
        }
        let launch_config = runtime_config
            .bot_runtime_launch_config(*bot_runtime_spec(bot_kind))
            .map_err(|error| {
                append_desktop_log(
                    app,
                    BOT_LOG_LEVEL_ERROR,
                    &format!("Trading bot recipient validation failed: {error}"),
                );
                "Trading bot runtime failed security validation. See desktop-app logs.".to_owned()
            })?;

        let wallets = self
            .store
            .list_wallets()
            .map_err(|error| format!("Wallet metadata could not be loaded: {error}"))?;
        let assigned_wallet = wallets
            .iter()
            .find(|wallet| wallet.is_assigned_to_bot(bot_kind))
            .cloned()
            .ok_or_else(|| "Assign a wallet to this bot before starting it.".to_owned())?;

        // Reserve this start before the canonical collection read yields to another command.
        runtime.begin_bot_unlock(app, bot_kind)?;
        if let Err(error) = runtime
            .wait_until_bot_dependencies_stable(bot_kind, self.bot_unlock_stabilization_delay_ms)
        {
            let _ = runtime.set_bot_runtime_state(
                app,
                bot_kind,
                BotRuntimeState::Error,
                Some(error.clone()),
            );
            return Err(error);
        }

        // Re-resolve browser-proposed ids immediately before native authorization.
        let (bidding_mandate, prompt_mandate) = match resolve_bidding_start_mandate(
            app,
            &runtime_config,
            &launch_config.process_env,
            bot_kind,
            bidding_mandate_draft,
        )
        .await
        {
            Ok(authority) => authority,
            Err(error) => {
                let _ = runtime.set_bot_runtime_state(
                    app,
                    bot_kind,
                    BotRuntimeState::Error,
                    Some(error.clone()),
                );
                return Err(error);
            }
        };

        let prompt_output = match self
            .prompt
            .request_unlock(
                app,
                assigned_wallet.label.as_str().to_owned(),
                assigned_wallet.address.as_str().to_owned(),
                bot_runtime_spec(bot_kind).startup_reason.to_owned(),
                prompt_mandate,
            )
            .await
        {
            Ok(output) => output,
            Err(SecretPromptError::Cancelled { .. }) => {
                append_desktop_log(
                    app,
                    BOT_LOG_LEVEL_INFO,
                    &format!("{bot_kind:?} bot unlock prompt cancelled"),
                );
                runtime.set_bot_runtime_state(app, bot_kind, BotRuntimeState::Locked, None)?;
                return self.get_bot_runtime_dto(app, runtime, bot_kind);
            }
            Err(error) => {
                append_desktop_log(
                    app,
                    BOT_LOG_LEVEL_ERROR,
                    &format!("Bot unlock prompt failed: {error}"),
                );
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
                append_desktop_log(
                    app,
                    BOT_LOG_LEVEL_ERROR,
                    &format!("Bot wallet unlock failed: {error}"),
                );
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
            launch_config.chain_id,
            bidding_mandate.as_ref(),
            &unlocked_wallet.private_key,
        )
        .map_err(|error| {
            append_desktop_log(
                app,
                BOT_LOG_LEVEL_ERROR,
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

        runtime.set_bot_bidding_mandate(app, bot_kind, bidding_mandate)?;
        runtime.set_bot_runtime_state(app, bot_kind, BotRuntimeState::Starting, None)?;
        runtime
            .start_bot_runtime(app.clone(), launch_config, secret_envelope)
            .map_err(|error| {
                append_desktop_log(
                    app,
                    BOT_LOG_LEVEL_ERROR,
                    &format!("Trading bot start failed: {error}"),
                );
                let _ = runtime.set_bot_runtime_state(
                    app,
                    bot_kind,
                    BotRuntimeState::Error,
                    Some("Trading bot failed to start. See desktop-app logs.".to_owned()),
                );
                "Trading bot failed to start. See desktop-app logs.".to_owned()
            })?;

        self.get_bot_runtime_dto(app, runtime, bot_kind)
    }

    fn stop_bot(
        &self,
        app: &AppHandle,
        runtime: &RuntimeManager,
        bot_kind: BotKind,
    ) -> Result<BotRuntimeDto, String> {
        runtime.stop_bot_runtime(app, bot_kind)?;
        self.get_bot_runtime_dto(app, runtime, bot_kind)
    }

    fn get_bot_runtime_dto(
        &self,
        app: &AppHandle,
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
        let disabled_reason = resolve_bot_disabled_reason(app, bot_kind)?;
        Ok(self.to_bot_runtime_dto(&snapshot, &wallets, disabled_reason))
    }

    fn to_bot_runtime_dto(
        &self,
        snapshot: &BotRuntimeSnapshot,
        wallets: &[WalletMetadata],
        disabled_reason: Option<String>,
    ) -> BotRuntimeDto {
        let assigned_wallet = wallets
            .iter()
            .find(|wallet| wallet.is_assigned_to_bot(snapshot.bot_kind))
            .map(BotAssignedWalletDto::from_metadata);

        BotRuntimeDto {
            bot_kind: BotKindDto::from_domain(snapshot.bot_kind),
            process_name: snapshot.process_name.clone(),
            state: BotRuntimeStateDto::from_runtime_snapshot(
                snapshot.state,
                assigned_wallet.is_some(),
                disabled_reason.as_deref(),
            ),
            last_error: snapshot.last_error.clone(),
            disabled_reason,
            critical_dependencies: snapshot
                .critical_dependencies
                .iter()
                .map(BotCriticalDependencyStatusDto::from_runtime)
                .collect(),
            assigned_wallet,
            bidding_mandate: snapshot
                .bidding_mandate
                .as_ref()
                .map(BiddingMandateDto::from_domain),
        }
    }
}

async fn resolve_bidding_start_mandate(
    app: &AppHandle,
    runtime_config: &DesktopRuntimeConfig,
    frozen_process_env: &std::collections::HashMap<String, String>,
    bot_kind: BotKind,
    draft: Option<BiddingMandateDraftDto>,
) -> Result<(Option<BiddingMandate>, Option<UnlockBiddingMandateSummary>), String> {
    match bot_kind {
        BotKind::Bidding => {
            let draft = draft
                .ok_or_else(|| "Select at least one collection to authorize bidding.".to_owned())?;
            let catalog = load_canonical_bidding_catalog(app, runtime_config).await?;
            let mandate = BiddingMandate::resolve(
                runtime_config.chain_id,
                draft.into_domain(),
                catalog.collections,
            )?;
            let policy = BiddingStartPolicySnapshot::from_process_env(frozen_process_env)?;
            let prompt_summary =
                build_prompt_mandate_summary(&mandate, &policy, catalog.chain.name.as_str())?;
            Ok((Some(mandate), Some(prompt_summary)))
        }
        BotKind::Sniping => {
            if draft.is_some() {
                return Err("Sniping bot start cannot include a bidding mandate.".to_owned());
            }
            Ok((None, None))
        }
    }
}

async fn load_canonical_bidding_catalog(
    app: &AppHandle,
    runtime_config: &DesktopRuntimeConfig,
) -> Result<BiddingCollectionCatalog, String> {
    // Read canonical identities through the shared desktop HTTP policy.
    let catalog = BackendCollectionCatalog::new(
        runtime_config.backend_http_base_url(),
        &runtime_config.http_fetch_resilience,
    )
    .map_err(|error| report_bidding_catalog_error(app, error))?;
    catalog
        .load_bidding_catalog(runtime_config.chain_id)
        .await
        .map_err(|error| report_bidding_catalog_error(app, error))
}

fn report_bidding_catalog_error(app: &AppHandle, error: BackendCollectionCatalogError) -> String {
    append_desktop_log(
        app,
        BOT_LOG_LEVEL_ERROR,
        &format!("Bidding collection catalog failed: {}", error.detail()),
    );
    error.user_message().to_owned()
}

fn build_prompt_mandate_summary(
    mandate: &BiddingMandate,
    policy: &BiddingStartPolicySnapshot,
    chain_name: &str,
) -> Result<UnlockBiddingMandateSummary, String> {
    let collections = mandate
        .collections
        .iter()
        .map(|collection| {
            Ok(UnlockBiddingCollectionSummary {
                collection_id: collection.collection_id,
                artgod_slug: collection.artgod_slug.clone(),
                contract_address: collection.contract_address.clone(),
                opensea_slug: collection.opensea_slug.clone(),
                token_scope_label: collection.token_scope.label.clone(),
                token_scope_items: collection
                    .token_scope
                    .items
                    .iter()
                    .map(|item| UnlockBiddingTokenScopeItem {
                        label: item.label.clone(),
                        value: item.value.clone(),
                    })
                    .collect(),
                max_unit_bid_eth: format_wei_as_eth(collection.max_unit_bid_wei.as_str())?,
                max_quantity: collection.max_quantity,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(UnlockBiddingMandateSummary {
        chain_id: mandate.chain_id,
        chain_name: chain_name.to_owned(),
        dry_run: policy.dry_run,
        weth_allowance_cap_eth: policy.weth_allowance_cap_eth.clone(),
        trait_offers_enabled: policy.trait_offers_enabled,
        collections,
    })
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
    Bootstrapping,
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
    disabled_reason: Option<String>,
    critical_dependencies: Vec<BotCriticalDependencyStatusDto>,
    assigned_wallet: Option<BotAssignedWalletDto>,
    bidding_mandate: Option<BiddingMandateDto>,
}

/// Admin transport shape for one canonical bidding collection candidate.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingCollectionCandidateDto {
    chain_id: u64,
    collection_id: u64,
    artgod_slug: String,
    contract_address: String,
    opensea_slug: String,
    token_scope: BiddingTokenScopeSummaryDto,
}

/// Admin transport shape for canonical bidding chain context and collections.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingCollectionCatalogDto {
    chain: BiddingChainIdentityDto,
    max_offer_quantity: u32,
    collections: Vec<BiddingCollectionCandidateDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BiddingChainIdentityDto {
    chain_id: u64,
    name: String,
}

/// Admin transport shape for a proposed native bidding mandate.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BiddingMandateDraftDto {
    collections: Vec<BiddingCollectionMandateDraftDto>,
}

/// Admin transport shape for one proposed collection price cap.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BiddingCollectionMandateDraftDto {
    collection_id: u64,
    max_unit_bid_eth: String,
}

/// Admin transport shape for the authority held by the active process.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingMandateDto {
    chain_id: u64,
    collections: Vec<BiddingCollectionMandateDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BiddingCollectionMandateDto {
    collection_id: u64,
    artgod_slug: String,
    contract_address: String,
    opensea_slug: String,
    token_scope: BiddingTokenScopeSummaryDto,
    max_unit_bid_wei: String,
    max_quantity: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BiddingTokenScopeSummaryDto {
    label: String,
    items: Vec<BiddingTokenScopeItemDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BiddingTokenScopeItemDto {
    label: String,
    value: String,
}

impl BiddingMandateDraftDto {
    fn into_domain(self) -> BiddingMandateDraft {
        BiddingMandateDraft {
            collections: self
                .collections
                .into_iter()
                .map(|collection| BiddingCollectionMandateDraft {
                    collection_id: collection.collection_id,
                    max_unit_bid_eth: collection.max_unit_bid_eth,
                })
                .collect(),
        }
    }
}

impl BiddingCollectionCandidateDto {
    fn from_domain(candidate: &BiddingCollectionCandidate) -> Self {
        Self {
            chain_id: candidate.chain_id,
            collection_id: candidate.collection_id,
            artgod_slug: candidate.artgod_slug.clone(),
            contract_address: candidate.contract_address.clone(),
            opensea_slug: candidate.opensea_slug.clone(),
            token_scope: BiddingTokenScopeSummaryDto::from_domain(&candidate.token_scope),
        }
    }
}

impl BiddingCollectionCatalogDto {
    fn from_domain(catalog: &BiddingCollectionCatalog) -> Self {
        Self {
            chain: BiddingChainIdentityDto::from_domain(&catalog.chain),
            max_offer_quantity: BIDDING_MANDATE_MAX_OFFER_QUANTITY,
            collections: catalog
                .collections
                .iter()
                .map(BiddingCollectionCandidateDto::from_domain)
                .collect(),
        }
    }
}

impl BiddingChainIdentityDto {
    fn from_domain(chain: &BiddingChainIdentity) -> Self {
        Self {
            chain_id: chain.chain_id,
            name: chain.name.clone(),
        }
    }
}

impl BiddingMandateDto {
    fn from_domain(mandate: &BiddingMandate) -> Self {
        Self {
            chain_id: mandate.chain_id,
            collections: mandate
                .collections
                .iter()
                .map(BiddingCollectionMandateDto::from_domain)
                .collect(),
        }
    }
}

impl BiddingCollectionMandateDto {
    fn from_domain(collection: &BiddingCollectionMandate) -> Self {
        Self {
            collection_id: collection.collection_id,
            artgod_slug: collection.artgod_slug.clone(),
            contract_address: collection.contract_address.clone(),
            opensea_slug: collection.opensea_slug.clone(),
            token_scope: BiddingTokenScopeSummaryDto::from_domain(&collection.token_scope),
            max_unit_bid_wei: collection.max_unit_bid_wei.clone(),
            max_quantity: collection.max_quantity,
        }
    }
}

impl BiddingTokenScopeSummaryDto {
    fn from_domain(scope: &BiddingCollectionTokenScopeSummary) -> Self {
        Self {
            label: scope.label.clone(),
            items: scope
                .items
                .iter()
                .map(|item| BiddingTokenScopeItemDto {
                    label: item.label.clone(),
                    value: item.value.clone(),
                })
                .collect(),
        }
    }
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
    fn from_runtime_snapshot(
        state: BotRuntimeState,
        has_assignment: bool,
        disabled_reason: Option<&str>,
    ) -> Self {
        if disabled_reason.is_some() && !is_runtime_state_active(state) {
            return Self::Disabled;
        }
        match state {
            BotRuntimeState::Disabled if has_assignment => Self::Locked,
            BotRuntimeState::Disabled => Self::Disabled,
            BotRuntimeState::Locked => Self::Locked,
            BotRuntimeState::AwaitingUnlock => Self::AwaitingUnlock,
            BotRuntimeState::Starting => Self::Starting,
            BotRuntimeState::Bootstrapping => Self::Bootstrapping,
            BotRuntimeState::Running => Self::Running,
            BotRuntimeState::Stopped => Self::Stopped,
            BotRuntimeState::Error => Self::Error,
        }
    }
}

fn is_runtime_state_active(state: BotRuntimeState) -> bool {
    matches!(
        state,
        BotRuntimeState::AwaitingUnlock
            | BotRuntimeState::Starting
            | BotRuntimeState::Bootstrapping
            | BotRuntimeState::Running
    )
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
    is_runtime_state_active(snapshot.state)
}

fn resolve_bot_disabled_reason(
    app: &AppHandle,
    bot_kind: BotKind,
) -> Result<Option<String>, String> {
    let capabilities = DesktopRuntimeConfig::load_capabilities(app)?;
    let process_env = DesktopRuntimeConfig::load_process_env(app)?;
    resolve_bot_disabled_reason_from_parts(
        capabilities.opensea.enabled,
        capabilities.opensea.reason.as_deref(),
        &process_env,
        bot_kind,
    )
}

fn resolve_bot_disabled_reason_from_config(
    config: &DesktopRuntimeConfig,
    bot_kind: BotKind,
) -> Result<Option<String>, String> {
    resolve_bot_disabled_reason_from_parts(
        config.capabilities.opensea.enabled,
        config.capabilities.opensea.reason.as_deref(),
        &config.process_env,
        bot_kind,
    )
}

fn resolve_bot_disabled_reason_from_parts(
    opensea_enabled: bool,
    opensea_reason: Option<&str>,
    process_env: &std::collections::HashMap<String, String>,
    bot_kind: BotKind,
) -> Result<Option<String>, String> {
    if !opensea_enabled {
        return Ok(Some(
            opensea_reason
                .unwrap_or("OpenSea integration is disabled")
                .to_owned(),
        ));
    }

    if bot_kind == BotKind::Bidding {
        if !parse_optional_bool(process_env, "BIDDING_ENABLED", true)? {
            return Ok(Some("BIDDING_ENABLED=false".to_owned()));
        }
        let missing = missing_env_keys(process_env, BIDDING_OPEN_SEA_SECRET_KEYS);
        if !missing.is_empty() {
            return Ok(Some(format!(
                "Bidding bot disabled because {} {} not configured",
                join_key_list(&missing),
                if missing.len() == 1 { "is" } else { "are" }
            )));
        }
    }

    Ok(None)
}

fn missing_env_keys(
    process_env: &std::collections::HashMap<String, String>,
    keys: &[&str],
) -> Vec<String> {
    keys.iter()
        .filter(|key| {
            process_env
                .get(**key)
                .map(String::as_str)
                .unwrap_or("")
                .trim()
                .is_empty()
        })
        .map(|key| (*key).to_owned())
        .collect()
}

fn parse_optional_bool(
    process_env: &std::collections::HashMap<String, String>,
    key: &str,
    default_value: bool,
) -> Result<bool, String> {
    let Some(value) = process_env.get(key) else {
        return Ok(default_value);
    };
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Ok(default_value);
    }
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "Invalid {key}: {value}. Use true/false, 1/0, yes/no, on/off."
        )),
    }
}

fn join_key_list(keys: &[String]) -> String {
    if keys.len() == 1 {
        return keys[0].clone();
    }
    keys.join(", ")
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
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    state: State<'_, BotCommandState>,
) -> Result<Vec<BotRuntimeDto>, String> {
    state.list_bots(&app, &desktop.runtime)
}

#[tauri::command]
pub async fn bot_list_bidding_collections(
    app: AppHandle,
    state: State<'_, BotCommandState>,
) -> Result<BiddingCollectionCatalogDto, String> {
    let command_state = state.inner().clone();
    command_state.load_bidding_collection_catalog(&app).await
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
    bidding_mandate: Option<BiddingMandateDraftDto>,
) -> Result<BotRuntimeDto, String> {
    let command_state = state.inner().clone();
    command_state
        .start_bot(
            &app,
            &desktop.runtime,
            bot_kind.into_domain(),
            bidding_mandate,
        )
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::BiddingMandateDraftDto;

    #[test]
    fn bidding_draft_rejects_browser_offer_quantity_override() {
        let draft = json!({
            "collections": [{
                "collectionId": 7,
                "maxUnitBidEth": "1",
                "maxQuantity": 99
            }]
        });

        assert!(serde_json::from_value::<BiddingMandateDraftDto>(draft).is_err());
    }
}
