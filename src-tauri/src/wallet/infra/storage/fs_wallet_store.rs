use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use thiserror::Error;

use crate::private_file::{apply_private_file_permissions, write_private_file_atomic};
use crate::wallet::application::use_cases::{
    AssignWalletToBotError, AssignWalletToBotStorePort, ExportWalletError, ExportWalletStorePort,
    ImportWalletError, ImportWalletStorePort, ListWalletsError, ListWalletsStorePort,
    RemoveWalletError, RemoveWalletStorePort, UnlockWalletForBotStartError,
    UnlockWalletForBotStartStorePort,
};
use crate::wallet::domain::{WalletId, WalletMetadata, WalletRecord, keystore_path_for};

const WALLET_INDEX_VERSION: u8 = 1;

/// Filesystem-backed wallet metadata store under desktop app-data.
#[derive(Clone, Debug)]
pub struct FsWalletStore {
    wallet_dir: PathBuf,
    index_path: PathBuf,
    #[cfg(test)]
    fail_next_atomic_write: Arc<AtomicBool>,
}

impl FsWalletStore {
    /// Creates or opens the wallet store rooted at the given directory.
    pub fn new(wallet_dir: PathBuf) -> Result<Self, FsWalletStoreError> {
        let index_path = wallet_dir.join("index.json");
        Self::new_with_paths(wallet_dir, index_path)
    }

    /// Creates or opens the wallet store with explicit directory and index paths.
    pub fn new_with_paths(
        wallet_dir: PathBuf,
        index_path: PathBuf,
    ) -> Result<Self, FsWalletStoreError> {
        ensure_private_dir(&wallet_dir)?;
        let store = Self {
            wallet_dir,
            index_path,
            #[cfg(test)]
            fail_next_atomic_write: Arc::new(AtomicBool::new(false)),
        };
        store.ensure_index_file()?;
        store.reconcile_pending_removals()?;
        Ok(store)
    }

    /// Returns the wallet directory for storage and tests.
    pub fn wallet_dir(&self) -> &Path {
        &self.wallet_dir
    }

    /// Returns the metadata index path for storage and tests.
    pub fn index_path(&self) -> &Path {
        &self.index_path
    }

    /// Returns the keystore file path for a wallet id.
    pub fn keystore_path(&self, wallet_id: &WalletId) -> PathBuf {
        keystore_path_for(&self.wallet_dir, wallet_id)
    }

    /// Lists wallet metadata from the persisted index.
    pub fn list_wallets(&self) -> Result<Vec<WalletMetadata>, FsWalletStoreError> {
        Ok(self.read_index()?.wallets)
    }

    /// Returns a full wallet record including the keystore path.
    pub fn get_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, FsWalletStoreError> {
        let index = self.read_index()?;
        let Some(metadata) = index
            .wallets
            .into_iter()
            .find(|wallet| &wallet.wallet_id == wallet_id)
        else {
            return Err(FsWalletStoreError::WalletNotFound {
                wallet_id: wallet_id.to_string(),
            });
        };
        let keystore_path = self.keystore_path(wallet_id);
        if !keystore_path.exists() {
            return Err(FsWalletStoreError::MissingKeystoreFile {
                path: keystore_path.display().to_string(),
            });
        }
        Ok(WalletRecord::new(metadata, keystore_path))
    }

    /// Inserts a new wallet metadata entry into the index.
    pub fn insert_wallet_metadata(
        &self,
        metadata: WalletMetadata,
    ) -> Result<(), FsWalletStoreError> {
        let mut index = self.read_index()?;
        if index
            .wallets
            .iter()
            .any(|wallet| wallet.matches_label(&metadata.label))
        {
            return Err(FsWalletStoreError::DuplicateLabel {
                label: metadata.label.as_str().to_owned(),
            });
        }
        if index
            .wallets
            .iter()
            .any(|wallet| wallet.matches_address(&metadata.address))
        {
            return Err(FsWalletStoreError::DuplicateAddress {
                address: metadata.address.as_str().to_owned(),
            });
        }
        index.wallets.push(metadata);
        self.write_index_atomic(&index)
    }

    /// Removes a stray keystore artifact after a failed import.
    pub fn remove_keystore_artifact(&self, wallet_id: &WalletId) -> Result<(), FsWalletStoreError> {
        let keystore_path = self.keystore_path(wallet_id);
        if !keystore_path.exists() {
            return Ok(());
        }
        fs::remove_file(&keystore_path).map_err(|error| FsWalletStoreError::IoFailure {
            message: format!(
                "Failed to remove wallet keystore {}: {error}",
                keystore_path.display()
            ),
        })
    }

    /// Removes wallet metadata and keystore with rollback if the index write fails.
    pub fn remove_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, FsWalletStoreError> {
        let mut index = self.read_index()?;
        let position = index
            .wallets
            .iter()
            .position(|wallet| &wallet.wallet_id == wallet_id)
            .ok_or_else(|| FsWalletStoreError::WalletNotFound {
                wallet_id: wallet_id.to_string(),
            })?;

        let metadata = index.wallets.remove(position);
        let keystore_path = self.keystore_path(wallet_id);
        if !keystore_path.exists() {
            return Err(FsWalletStoreError::MissingKeystoreFile {
                path: keystore_path.display().to_string(),
            });
        }

        let pending_path = self.wallet_dir.join(wallet_id.pending_removal_file_name());
        fs::rename(&keystore_path, &pending_path).map_err(|error| {
            FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to stage wallet keystore removal {}: {error}",
                    keystore_path.display()
                ),
            }
        })?;

        if let Err(error) = self.write_index_atomic(&index) {
            let _ = fs::rename(&pending_path, &keystore_path);
            return Err(error);
        }

        if let Err(error) = fs::remove_file(&pending_path) {
            return Err(FsWalletStoreError::IoFailure {
                message: format!(
                    "Wallet metadata was removed but keystore cleanup failed {}: {error}",
                    pending_path.display()
                ),
            });
        }

        Ok(WalletRecord::new(metadata, keystore_path))
    }

    /// Replaces a set of wallet metadata records atomically by wallet id.
    pub fn replace_wallet_metadata_batch(
        &self,
        updated_wallets: &[WalletMetadata],
    ) -> Result<(), FsWalletStoreError> {
        let mut index = self.read_index()?;
        for updated_wallet in updated_wallets {
            let Some(position) = index
                .wallets
                .iter()
                .position(|wallet| wallet.wallet_id == updated_wallet.wallet_id)
            else {
                return Err(FsWalletStoreError::WalletNotFound {
                    wallet_id: updated_wallet.wallet_id.to_string(),
                });
            };
            index.wallets[position] = updated_wallet.clone();
        }
        self.write_index_atomic(&index)
    }

    fn ensure_index_file(&self) -> Result<(), FsWalletStoreError> {
        if self.index_path.exists() {
            apply_private_file_permissions(&self.index_path)
                .map_err(|message| FsWalletStoreError::IoFailure { message })?;
            return Ok(());
        }
        self.write_index_atomic(&WalletIndexDocument::default())
    }

    fn reconcile_pending_removals(&self) -> Result<(), FsWalletStoreError> {
        let index = self.read_index()?;
        for entry in
            fs::read_dir(&self.wallet_dir).map_err(|error| FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to read wallet directory {}: {error}",
                    self.wallet_dir.display()
                ),
            })?
        {
            let entry = entry.map_err(|error| FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to read wallet directory entry {}: {error}",
                    self.wallet_dir.display()
                ),
            })?;
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            let Some(wallet_id) = WalletId::from_pending_removal_file_name(&file_name) else {
                continue;
            };

            let pending_path = entry.path();
            let canonical_path = self.keystore_path(&wallet_id);
            let wallet_exists = index
                .wallets
                .iter()
                .any(|wallet| wallet.wallet_id == wallet_id);
            if wallet_exists {
                if !canonical_path.exists() {
                    fs::rename(&pending_path, &canonical_path).map_err(|error| {
                        FsWalletStoreError::IoFailure {
                            message: format!(
                                "Failed to restore pending wallet keystore {}: {error}",
                                canonical_path.display()
                            ),
                        }
                    })?;
                }
                continue;
            }

            fs::remove_file(&pending_path).map_err(|error| FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to cleanup pending wallet keystore {}: {error}",
                    pending_path.display()
                ),
            })?;
        }
        Ok(())
    }

    fn read_index(&self) -> Result<WalletIndexDocument, FsWalletStoreError> {
        let raw = fs::read_to_string(&self.index_path).map_err(|error| {
            FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to read wallet index {}: {error}",
                    self.index_path.display()
                ),
            }
        })?;
        let index: WalletIndexDocument =
            serde_json::from_str(&raw).map_err(|error| FsWalletStoreError::SerdeFailure {
                message: format!(
                    "Failed to parse wallet index {}: {error}",
                    self.index_path.display()
                ),
            })?;
        if index.version != WALLET_INDEX_VERSION {
            return Err(FsWalletStoreError::UnsupportedIndexVersion {
                version: index.version,
            });
        }
        Ok(index)
    }

    fn write_index_atomic(&self, index: &WalletIndexDocument) -> Result<(), FsWalletStoreError> {
        self.maybe_fail_next_atomic_write()?;

        let payload =
            serde_json::to_vec_pretty(index).map_err(|error| FsWalletStoreError::SerdeFailure {
                message: format!("Failed to serialize wallet index: {error}"),
            })?;
        write_private_file_atomic(&self.index_path, &payload)
            .map_err(|message| FsWalletStoreError::IoFailure { message })
    }

    #[cfg(test)]
    fn maybe_fail_next_atomic_write(&self) -> Result<(), FsWalletStoreError> {
        if self.fail_next_atomic_write.swap(false, Ordering::SeqCst) {
            return Err(FsWalletStoreError::InjectedAtomicWriteFailure);
        }
        Ok(())
    }

    #[cfg(not(test))]
    fn maybe_fail_next_atomic_write(&self) -> Result<(), FsWalletStoreError> {
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail_next_atomic_write_for_test(&self) {
        self.fail_next_atomic_write.store(true, Ordering::SeqCst);
    }
}

impl ListWalletsStorePort for FsWalletStore {
    fn list_wallets(&self) -> Result<Vec<WalletMetadata>, ListWalletsError> {
        FsWalletStore::list_wallets(self).map_err(|error| ListWalletsError::StorageFailure {
            message: error.to_string(),
        })
    }
}

impl ImportWalletStorePort for FsWalletStore {
    fn list_wallets(&self) -> Result<Vec<WalletMetadata>, ImportWalletError> {
        FsWalletStore::list_wallets(self).map_err(|error| ImportWalletError::StorageFailure {
            message: error.to_string(),
        })
    }

    fn keystore_path(&self, wallet_id: &WalletId) -> PathBuf {
        FsWalletStore::keystore_path(self, wallet_id)
    }

    fn insert_wallet_metadata(&self, metadata: WalletMetadata) -> Result<(), ImportWalletError> {
        FsWalletStore::insert_wallet_metadata(self, metadata).map_err(|error| match error {
            FsWalletStoreError::DuplicateLabel { label } => {
                ImportWalletError::DuplicateLabel { label }
            }
            FsWalletStoreError::DuplicateAddress { address } => {
                ImportWalletError::DuplicateAddress { address }
            }
            other => ImportWalletError::StorageFailure {
                message: other.to_string(),
            },
        })
    }

    fn remove_keystore_artifact(&self, wallet_id: &WalletId) -> Result<(), ImportWalletError> {
        FsWalletStore::remove_keystore_artifact(self, wallet_id).map_err(|error| {
            ImportWalletError::StorageFailure {
                message: error.to_string(),
            }
        })
    }
}

impl RemoveWalletStorePort for FsWalletStore {
    fn get_wallet_record(&self, wallet_id: &WalletId) -> Result<WalletRecord, RemoveWalletError> {
        FsWalletStore::get_wallet_record(self, wallet_id).map_err(map_remove_error)
    }

    fn remove_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, RemoveWalletError> {
        FsWalletStore::remove_wallet_record(self, wallet_id).map_err(map_remove_error)
    }
}

impl ExportWalletStorePort for FsWalletStore {
    fn get_wallet_record(&self, wallet_id: &WalletId) -> Result<WalletRecord, ExportWalletError> {
        FsWalletStore::get_wallet_record(self, wallet_id).map_err(|error| match error {
            FsWalletStoreError::WalletNotFound { wallet_id } => {
                ExportWalletError::WalletNotFound { wallet_id }
            }
            other => ExportWalletError::StorageFailure {
                message: other.to_string(),
            },
        })
    }
}

impl AssignWalletToBotStorePort for FsWalletStore {
    fn list_wallets(&self) -> Result<Vec<WalletMetadata>, AssignWalletToBotError> {
        FsWalletStore::list_wallets(self).map_err(|error| AssignWalletToBotError::StorageFailure {
            message: error.to_string(),
        })
    }

    fn get_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, AssignWalletToBotError> {
        FsWalletStore::get_wallet_record(self, wallet_id).map_err(|error| match error {
            FsWalletStoreError::WalletNotFound { wallet_id } => {
                AssignWalletToBotError::WalletNotFound { wallet_id }
            }
            other => AssignWalletToBotError::StorageFailure {
                message: other.to_string(),
            },
        })
    }

    fn replace_wallet_metadata_batch(
        &self,
        updated_wallets: &[WalletMetadata],
    ) -> Result<(), AssignWalletToBotError> {
        FsWalletStore::replace_wallet_metadata_batch(self, updated_wallets).map_err(|error| {
            match error {
                FsWalletStoreError::WalletNotFound { wallet_id } => {
                    AssignWalletToBotError::WalletNotFound { wallet_id }
                }
                other => AssignWalletToBotError::StorageFailure {
                    message: other.to_string(),
                },
            }
        })
    }
}

impl UnlockWalletForBotStartStorePort for FsWalletStore {
    fn get_wallet_record(
        &self,
        wallet_id: &WalletId,
    ) -> Result<WalletRecord, UnlockWalletForBotStartError> {
        FsWalletStore::get_wallet_record(self, wallet_id).map_err(|error| match error {
            FsWalletStoreError::WalletNotFound { wallet_id } => {
                UnlockWalletForBotStartError::WalletNotFound { wallet_id }
            }
            other => UnlockWalletForBotStartError::StorageFailure {
                message: other.to_string(),
            },
        })
    }
}

fn map_remove_error(error: FsWalletStoreError) -> RemoveWalletError {
    match error {
        FsWalletStoreError::WalletNotFound { wallet_id } => {
            RemoveWalletError::WalletNotFound { wallet_id }
        }
        other => RemoveWalletError::StorageFailure {
            message: other.to_string(),
        },
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FsWalletStoreError {
    #[error("Wallet does not exist: {wallet_id}")]
    WalletNotFound { wallet_id: String },
    #[error("Wallet label already exists: {label}")]
    DuplicateLabel { label: String },
    #[error("Wallet address already exists: {address}")]
    DuplicateAddress { address: String },
    #[error("Wallet keystore file is missing: {path}")]
    MissingKeystoreFile { path: String },
    #[error("Wallet index version is unsupported: {version}")]
    UnsupportedIndexVersion { version: u8 },
    #[error("Wallet storage failed: {message}")]
    IoFailure { message: String },
    #[error("Wallet storage failed: {message}")]
    SerdeFailure { message: String },
    #[cfg(test)]
    #[error("Injected wallet index write failure for test")]
    InjectedAtomicWriteFailure,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletIndexDocument {
    version: u8,
    wallets: Vec<WalletMetadata>,
}

impl Default for WalletIndexDocument {
    fn default() -> Self {
        Self {
            version: WALLET_INDEX_VERSION,
            wallets: Vec::new(),
        }
    }
}

fn ensure_private_dir(path: &Path) -> Result<(), FsWalletStoreError> {
    #[cfg(unix)]
    {
        use std::fs::DirBuilder;
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        let mut builder = DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|error| FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to create wallet directory {}: {error}",
                    path.display()
                ),
            })?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            FsWalletStoreError::IoFailure {
                message: format!(
                    "Failed to restrict wallet directory permissions {}: {error}",
                    path.display()
                ),
            }
        })?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(|error| FsWalletStoreError::IoFailure {
            message: format!(
                "Failed to create wallet directory {}: {error}",
                path.display()
            ),
        })?;
    }
    Ok(())
}
