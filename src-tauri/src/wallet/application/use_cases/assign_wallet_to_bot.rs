use std::sync::Arc;

use thiserror::Error;

use crate::wallet::domain::{BotKind, WalletId, WalletMetadata, WalletRecord, now_rfc3339};

/// Reassigns a bot kind to a single stored wallet or clears the assignment.
pub struct AssignWalletToBot {
    store: Arc<dyn AssignWalletToBotStorePort>,
}

impl AssignWalletToBot {
    /// Creates the use case with a store outbound port.
    pub fn new(store: Arc<dyn AssignWalletToBotStorePort>) -> Self {
        Self { store }
    }

    /// Reassigns the bot kind to the requested wallet, clearing it from any previous owner.
    pub fn execute(
        &self,
        input: AssignWalletToBotInput,
    ) -> Result<AssignWalletToBotOutput, AssignWalletToBotError> {
        let wallet_id = match input.wallet_id {
            Some(wallet_id) => Some(WalletId::parse(wallet_id.as_str())?),
            None => None,
        };

        let existing_wallets = self.store.list_wallets()?;
        if let Some(wallet_id) = wallet_id.as_ref()
            && !existing_wallets
                .iter()
                .any(|wallet| &wallet.wallet_id == wallet_id)
        {
            return Err(AssignWalletToBotError::WalletNotFound {
                wallet_id: wallet_id.to_string(),
            });
        }

        let now = now_rfc3339();
        let updated_wallets = existing_wallets
            .iter()
            .filter_map(|wallet| {
                let was_assigned = wallet.is_assigned_to_bot(input.bot_kind);
                let should_assign = wallet_id
                    .as_ref()
                    .is_some_and(|target_wallet_id| &wallet.wallet_id == target_wallet_id);
                if !was_assigned && !should_assign {
                    return None;
                }

                let mut next_assignments = wallet.assigned_bot_kinds.clone();
                next_assignments.retain(|kind| *kind != input.bot_kind);
                if should_assign {
                    next_assignments.push(input.bot_kind);
                    next_assignments.sort_by_key(|kind| match kind {
                        BotKind::Bidding => 0_u8,
                        BotKind::Sniping => 1_u8,
                    });
                }

                Some(wallet.with_assigned_bot_kinds(next_assignments, now.clone()))
            })
            .collect::<Vec<_>>();

        self.store.replace_wallet_metadata_batch(&updated_wallets)?;

        let assigned_wallet = match wallet_id {
            Some(wallet_id) => Some(self.store.get_wallet_record(&wallet_id)?.metadata),
            None => None,
        };

        Ok(AssignWalletToBotOutput {
            bot_kind: input.bot_kind,
            assigned_wallet,
        })
    }
}

/// Outbound port for bot assignment reads and writes.
pub trait AssignWalletToBotStorePort: Send + Sync {
    fn list_wallets(&self) -> Result<Vec<WalletMetadata>, AssignWalletToBotError>;
    fn get_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, AssignWalletToBotError>;
    fn replace_wallet_metadata_batch(
        &self,
        updated_wallets: &[WalletMetadata],
    ) -> Result<(), AssignWalletToBotError>;
}

pub struct AssignWalletToBotInput {
    pub bot_kind: BotKind,
    pub wallet_id: Option<String>,
}

pub struct AssignWalletToBotOutput {
    pub bot_kind: BotKind,
    pub assigned_wallet: Option<WalletMetadata>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AssignWalletToBotError {
    #[error(transparent)]
    InvalidWalletId(#[from] crate::wallet::domain::WalletDomainError),
    #[error("Wallet does not exist: {wallet_id}")]
    WalletNotFound { wallet_id: String },
    #[error("Wallet metadata could not be updated: {message}")]
    StorageFailure { message: String },
}
