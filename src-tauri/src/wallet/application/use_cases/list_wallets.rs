use std::sync::Arc;

use thiserror::Error;

use crate::wallet::domain::WalletMetadata;

/// Lists wallet metadata without touching any secret material.
pub struct ListWallets {
    store: Arc<dyn ListWalletsStorePort>,
}

impl ListWallets {
    /// Creates the use case with the outbound store port it drives.
    pub fn new(store: Arc<dyn ListWalletsStorePort>) -> Self {
        Self { store }
    }

    /// Loads all stored wallet metadata.
    pub fn execute(&self) -> Result<ListWalletsOutput, ListWalletsError> {
        let mut wallets = self.store.list_wallets()?;
        wallets.sort_by(|left, right| left.label.as_str().cmp(right.label.as_str()));
        Ok(ListWalletsOutput { wallets })
    }
}

/// Outbound port for reading wallet metadata.
pub trait ListWalletsStorePort: Send + Sync {
    fn list_wallets(&self) -> Result<Vec<WalletMetadata>, ListWalletsError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListWalletsOutput {
    pub wallets: Vec<WalletMetadata>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ListWalletsError {
    #[error("Wallet metadata could not be loaded: {message}")]
    StorageFailure { message: String },
}
