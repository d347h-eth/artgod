use std::sync::Arc;

use thiserror::Error;
use zeroize::Zeroizing;

use crate::wallet::domain::{
    PassphrasePolicy, PassphrasePolicyError, WalletId, WalletMetadata, WalletRecord,
};

/// Removes a stored wallet after verifying the passphrase.
pub struct RemoveWallet {
    store: Arc<dyn RemoveWalletStorePort>,
    keystore: Arc<dyn RemoveWalletKeystorePort>,
    passphrase_policy: PassphrasePolicy,
}

impl RemoveWallet {
    /// Creates the use case with store and keystore outbound ports.
    pub fn new(
        store: Arc<dyn RemoveWalletStorePort>,
        keystore: Arc<dyn RemoveWalletKeystorePort>,
        passphrase_policy: PassphrasePolicy,
    ) -> Self {
        Self {
            store,
            keystore,
            passphrase_policy,
        }
    }

    /// Verifies the passphrase and removes the wallet metadata plus keystore.
    pub fn execute(&self, input: RemoveWalletInput) -> Result<WalletMetadata, RemoveWalletError> {
        self.passphrase_policy
            .validate_existing(&input.passphrase)?;
        let wallet = self.store.get_wallet_record(&input.wallet_id)?;
        self.keystore
            .verify_passphrase(&wallet, &input.passphrase)?;
        let removed_wallet = self.store.remove_wallet_record(&input.wallet_id)?;
        Ok(removed_wallet.metadata)
    }
}

/// Outbound port for wallet record lookup and deletion.
pub trait RemoveWalletStorePort: Send + Sync {
    fn get_wallet_record(&self, wallet_id: &WalletId) -> Result<WalletRecord, RemoveWalletError>;
    fn remove_wallet_record(&self, wallet_id: &WalletId)
    -> Result<WalletRecord, RemoveWalletError>;
}

/// Outbound port for validating the passphrase against the keystore.
pub trait RemoveWalletKeystorePort: Send + Sync {
    fn verify_passphrase(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<(), RemoveWalletError>;
}

pub struct RemoveWalletInput {
    pub wallet_id: WalletId,
    pub passphrase: Zeroizing<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RemoveWalletError {
    #[error(transparent)]
    InvalidPassphraseInput(#[from] PassphrasePolicyError),
    #[error("Wallet does not exist: {wallet_id}")]
    WalletNotFound { wallet_id: String },
    #[error("Wallet passphrase was rejected or the keystore is unreadable")]
    UnlockRejected,
    #[error("Wallet metadata could not be updated: {message}")]
    StorageFailure { message: String },
}
