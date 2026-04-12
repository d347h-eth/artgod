use std::sync::Arc;

use thiserror::Error;
use zeroize::Zeroizing;

use crate::wallet::domain::{
    BotKind, PassphrasePolicy, PassphrasePolicyError, WalletId, WalletMetadata, WalletPrivateKey,
    WalletRecord,
};

/// Decrypts a wallet one time for bot startup handoff.
pub struct UnlockWalletForBotStart {
    store: Arc<dyn UnlockWalletForBotStartStorePort>,
    keystore: Arc<dyn UnlockWalletForBotStartKeystorePort>,
    passphrase_policy: PassphrasePolicy,
}

impl UnlockWalletForBotStart {
    /// Creates the use case with store and keystore outbound ports.
    pub fn new(
        store: Arc<dyn UnlockWalletForBotStartStorePort>,
        keystore: Arc<dyn UnlockWalletForBotStartKeystorePort>,
        passphrase_policy: PassphrasePolicy,
    ) -> Self {
        Self {
            store,
            keystore,
            passphrase_policy,
        }
    }

    /// Decrypts the wallet for a single bot startup attempt.
    pub fn execute(
        &self,
        input: UnlockWalletForBotStartInput,
    ) -> Result<UnlockedWalletForBotStart, UnlockWalletForBotStartError> {
        self.passphrase_policy
            .validate_existing(&input.passphrase)?;
        let wallet = self.store.get_wallet_record(&input.wallet_id)?;
        let private_key = self.keystore.decrypt_wallet(&wallet, &input.passphrase)?;
        Ok(UnlockedWalletForBotStart {
            metadata: wallet.metadata,
            bot_kind: input.bot_kind,
            private_key,
        })
    }
}

/// Outbound port for wallet record lookup.
pub trait UnlockWalletForBotStartStorePort: Send + Sync {
    fn get_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, UnlockWalletForBotStartError>;
}

/// Outbound port for one-shot keystore decrypt.
pub trait UnlockWalletForBotStartKeystorePort: Send + Sync {
    fn decrypt_wallet(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<WalletPrivateKey, UnlockWalletForBotStartError>;
}

pub struct UnlockWalletForBotStartInput {
    pub wallet_id: WalletId,
    pub bot_kind: BotKind,
    pub passphrase: Zeroizing<String>,
}

pub struct UnlockedWalletForBotStart {
    pub metadata: WalletMetadata,
    pub bot_kind: BotKind,
    pub private_key: WalletPrivateKey,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum UnlockWalletForBotStartError {
    #[error(transparent)]
    InvalidPassphraseInput(#[from] PassphrasePolicyError),
    #[error("Wallet does not exist: {wallet_id}")]
    WalletNotFound { wallet_id: String },
    #[error("Wallet passphrase was rejected or the keystore is unreadable")]
    UnlockRejected,
    #[error("Wallet metadata could not be loaded: {message}")]
    StorageFailure { message: String },
}
