use std::sync::Arc;

use thiserror::Error;
use zeroize::Zeroizing;

use crate::wallet::domain::{
    PassphrasePolicy, PassphrasePolicyError, WalletId, WalletMetadata, WalletPrivateKey,
    WalletRecord,
};

/// Decrypts a wallet for one-shot export handling.
pub struct ExportWallet {
    store: Arc<dyn ExportWalletStorePort>,
    keystore: Arc<dyn ExportWalletKeystorePort>,
    passphrase_policy: PassphrasePolicy,
}

impl ExportWallet {
    /// Creates the use case with store and keystore outbound ports.
    pub fn new(
        store: Arc<dyn ExportWalletStorePort>,
        keystore: Arc<dyn ExportWalletKeystorePort>,
        passphrase_policy: PassphrasePolicy,
    ) -> Self {
        Self {
            store,
            keystore,
            passphrase_policy,
        }
    }

    /// Decrypts the wallet and returns plaintext only to the trusted caller.
    pub fn execute(&self, input: ExportWalletInput) -> Result<ExportedWallet, ExportWalletError> {
        self.passphrase_policy
            .validate_existing(&input.passphrase)?;
        let wallet = self.store.get_wallet_record(&input.wallet_id)?;
        let private_key = self.keystore.decrypt_wallet(&wallet, &input.passphrase)?;
        Ok(ExportedWallet {
            metadata: wallet.metadata,
            private_key,
        })
    }
}

/// Outbound port for wallet record lookup.
pub trait ExportWalletStorePort: Send + Sync {
    fn get_wallet_record(&self, wallet_id: &WalletId) -> Result<WalletRecord, ExportWalletError>;
}

/// Outbound port for keystore decryption.
pub trait ExportWalletKeystorePort: Send + Sync {
    fn decrypt_wallet(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<WalletPrivateKey, ExportWalletError>;
}

pub struct ExportWalletInput {
    pub wallet_id: WalletId,
    pub passphrase: Zeroizing<String>,
}

#[derive(Debug)]
pub struct ExportedWallet {
    pub metadata: WalletMetadata,
    pub private_key: WalletPrivateKey,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExportWalletError {
    #[error(transparent)]
    InvalidPassphraseInput(#[from] PassphrasePolicyError),
    #[error("Wallet does not exist: {wallet_id}")]
    WalletNotFound { wallet_id: String },
    #[error("Wallet passphrase was rejected or the keystore is unreadable")]
    UnlockRejected,
    #[error("Wallet metadata could not be loaded: {message}")]
    StorageFailure { message: String },
}
