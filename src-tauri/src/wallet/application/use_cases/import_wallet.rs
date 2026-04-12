use std::path::PathBuf;
use std::sync::Arc;

use thiserror::Error;
use zeroize::Zeroizing;

use crate::wallet::domain::{
    PassphrasePolicy, PassphrasePolicyError, ValidatedWalletSecret, WalletId, WalletLabel,
    WalletMetadata, now_rfc3339,
};

/// Imports a private key into the desktop keystore store.
pub struct ImportWallet {
    store: Arc<dyn ImportWalletStorePort>,
    keystore: Arc<dyn ImportWalletKeystorePort>,
    passphrase_policy: PassphrasePolicy,
}

impl ImportWallet {
    /// Creates the use case with store and keystore outbound ports.
    pub fn new(
        store: Arc<dyn ImportWalletStorePort>,
        keystore: Arc<dyn ImportWalletKeystorePort>,
        passphrase_policy: PassphrasePolicy,
    ) -> Self {
        Self {
            store,
            keystore,
            passphrase_policy,
        }
    }

    /// Validates, encrypts, and stores a wallet.
    pub fn execute(&self, input: ImportWalletInput) -> Result<WalletMetadata, ImportWalletError> {
        let label = WalletLabel::parse(&input.label)?;
        self.passphrase_policy
            .validate_new(&input.passphrase, &input.passphrase_confirmation)?;

        let validated_secret = self.keystore.validate_private_key(input.private_key)?;
        let existing_wallets = self.store.list_wallets()?;

        if existing_wallets
            .iter()
            .any(|wallet| wallet.matches_label(&label))
        {
            return Err(ImportWalletError::DuplicateLabel {
                label: label.as_str().to_owned(),
            });
        }
        if existing_wallets
            .iter()
            .any(|wallet| wallet.matches_address(&validated_secret.address))
        {
            return Err(ImportWalletError::DuplicateAddress {
                address: validated_secret.address.as_str().to_owned(),
            });
        }

        let wallet_id = WalletId::new_random();
        let keystore_path = self.store.keystore_path(&wallet_id);
        let now = now_rfc3339();
        let metadata = WalletMetadata::new(
            wallet_id.clone(),
            label,
            validated_secret.address.clone(),
            now,
        );

        if let Err(error) = self.keystore.write_keystore(
            &keystore_path,
            &validated_secret.private_key,
            &input.passphrase,
        ) {
            return Err(error);
        }

        if let Err(error) = self.store.insert_wallet_metadata(metadata.clone()) {
            let cleanup_error = self.store.remove_keystore_artifact(&wallet_id).err();
            return Err(match cleanup_error {
                Some(cleanup_error) => ImportWalletError::StorageFailure {
                    message: format!("{error}; cleanup failed: {cleanup_error}"),
                },
                None => error,
            });
        }

        Ok(metadata)
    }
}

/// Outbound port for wallet index and file-path storage concerns.
pub trait ImportWalletStorePort: Send + Sync {
    fn list_wallets(&self) -> Result<Vec<WalletMetadata>, ImportWalletError>;
    fn keystore_path(&self, wallet_id: &WalletId) -> PathBuf;
    fn insert_wallet_metadata(&self, metadata: WalletMetadata) -> Result<(), ImportWalletError>;
    fn remove_keystore_artifact(&self, wallet_id: &WalletId) -> Result<(), ImportWalletError>;
}

/// Outbound port for keystore validation and encryption.
pub trait ImportWalletKeystorePort: Send + Sync {
    fn validate_private_key(
        &self,
        private_key: Zeroizing<String>,
    ) -> Result<ValidatedWalletSecret, ImportWalletError>;
    fn write_keystore(
        &self,
        keystore_path: &std::path::Path,
        private_key: &crate::wallet::domain::WalletPrivateKey,
        passphrase: &Zeroizing<String>,
    ) -> Result<(), ImportWalletError>;
}

pub struct ImportWalletInput {
    pub label: String,
    pub private_key: Zeroizing<String>,
    pub passphrase: Zeroizing<String>,
    pub passphrase_confirmation: Zeroizing<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ImportWalletError {
    #[error(transparent)]
    InvalidLabel(#[from] crate::wallet::domain::WalletDomainError),
    #[error(transparent)]
    InvalidPassphrase(#[from] PassphrasePolicyError),
    #[error("Wallet private key is invalid")]
    InvalidPrivateKey,
    #[error("Wallet label already exists: {label}")]
    DuplicateLabel { label: String },
    #[error("Wallet address already exists: {address}")]
    DuplicateAddress { address: String },
    #[error("Wallet metadata could not be updated: {message}")]
    StorageFailure { message: String },
    #[error("Wallet keystore could not be written: {message}")]
    KeystoreFailure { message: String },
}
