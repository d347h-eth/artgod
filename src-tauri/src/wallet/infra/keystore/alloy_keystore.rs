use std::path::Path;

use alloy_primitives::hex;
use alloy_signer_local::{LocalSignerError, PrivateKeySigner};
use rand::thread_rng;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::private_file::apply_private_file_permissions;
use crate::wallet::application::use_cases::{
    ExportWalletError, ExportWalletKeystorePort, ImportWalletError, ImportWalletKeystorePort,
    RemoveWalletError, RemoveWalletKeystorePort, UnlockWalletForBotStartError,
    UnlockWalletForBotStartKeystorePort,
};
use crate::wallet::domain::{ValidatedWalletSecret, WalletAddress, WalletPrivateKey, WalletRecord};

/// Alloy-backed Ethereum keystore adapter aligned with Foundry's wallet path.
#[derive(Clone, Debug, Default)]
pub struct AlloyKeystore;

impl AlloyKeystore {
    /// Validates a hex private key and derives the canonical wallet address.
    pub fn validate_private_key(
        &self,
        private_key: Zeroizing<String>,
    ) -> Result<ValidatedWalletSecret, AlloyKeystoreError> {
        let normalized = private_key.trim();
        let normalized = normalized.strip_prefix("0x").unwrap_or(normalized);
        let raw_key = hex::decode_to_array::<_, 32>(normalized)
            .map_err(|_| AlloyKeystoreError::InvalidPrivateKey)?;
        let signer = PrivateKeySigner::from_slice(&raw_key)
            .map_err(|_| AlloyKeystoreError::InvalidPrivateKey)?;
        Ok(ValidatedWalletSecret::new(
            WalletAddress::from_alloy(signer.address()),
            raw_key,
        ))
    }

    /// Encrypts a private key into a standard Ethereum keystore file.
    pub fn write_keystore(
        &self,
        keystore_path: &Path,
        private_key: &WalletPrivateKey,
        passphrase: &Zeroizing<String>,
    ) -> Result<(), AlloyKeystoreError> {
        if keystore_path.exists() {
            return Err(AlloyKeystoreError::KeystoreAlreadyExists {
                path: keystore_path.display().to_string(),
            });
        }
        let parent_dir = keystore_path
            .parent()
            .ok_or_else(|| AlloyKeystoreError::InvalidPath {
                path: keystore_path.display().to_string(),
            })?;
        std::fs::create_dir_all(parent_dir).map_err(|error| AlloyKeystoreError::IoFailure {
            message: format!(
                "Failed to create wallet directory {}: {error}",
                parent_dir.display()
            ),
        })?;
        let file_name = keystore_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| AlloyKeystoreError::InvalidPath {
                path: keystore_path.display().to_string(),
            })?;
        let mut rng = thread_rng();
        PrivateKeySigner::encrypt_keystore(
            parent_dir,
            &mut rng,
            private_key.as_bytes(),
            passphrase.as_bytes(),
            Some(file_name),
        )
        .map_err(AlloyKeystoreError::from)?;
        apply_private_file_permissions(keystore_path).map_err(|error| {
            AlloyKeystoreError::IoFailure {
                message: format!(
                    "Failed to restrict wallet keystore permissions {}: {error}",
                    keystore_path.display()
                ),
            }
        })?;
        Ok(())
    }

    /// Decrypts a keystore file into one-shot private key material.
    pub fn decrypt_wallet(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<WalletPrivateKey, AlloyKeystoreError> {
        let signer =
            PrivateKeySigner::decrypt_keystore(&wallet.keystore_path, passphrase.as_bytes())
                .map_err(|_| AlloyKeystoreError::UnlockRejected)?;
        Ok(WalletPrivateKey::new(signer.to_bytes().0))
    }
}

impl ImportWalletKeystorePort for AlloyKeystore {
    fn validate_private_key(
        &self,
        private_key: Zeroizing<String>,
    ) -> Result<ValidatedWalletSecret, ImportWalletError> {
        AlloyKeystore::validate_private_key(self, private_key).map_err(|error| match error {
            AlloyKeystoreError::InvalidPrivateKey => ImportWalletError::InvalidPrivateKey,
            other => ImportWalletError::KeystoreFailure {
                message: other.to_string(),
            },
        })
    }

    fn write_keystore(
        &self,
        keystore_path: &Path,
        private_key: &WalletPrivateKey,
        passphrase: &Zeroizing<String>,
    ) -> Result<(), ImportWalletError> {
        AlloyKeystore::write_keystore(self, keystore_path, private_key, passphrase).map_err(
            |error| ImportWalletError::KeystoreFailure {
                message: error.to_string(),
            },
        )
    }
}

impl RemoveWalletKeystorePort for AlloyKeystore {
    fn verify_passphrase(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<(), RemoveWalletError> {
        AlloyKeystore::decrypt_wallet(self, wallet, passphrase)
            .map(|_| ())
            .map_err(|_| RemoveWalletError::UnlockRejected)
    }
}

impl ExportWalletKeystorePort for AlloyKeystore {
    fn decrypt_wallet(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<WalletPrivateKey, ExportWalletError> {
        AlloyKeystore::decrypt_wallet(self, wallet, passphrase)
            .map_err(|_| ExportWalletError::UnlockRejected)
    }
}

impl UnlockWalletForBotStartKeystorePort for AlloyKeystore {
    fn decrypt_wallet(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<WalletPrivateKey, UnlockWalletForBotStartError> {
        AlloyKeystore::decrypt_wallet(self, wallet, passphrase)
            .map_err(|_| UnlockWalletForBotStartError::UnlockRejected)
    }
}

#[derive(Debug, Error)]
pub enum AlloyKeystoreError {
    #[error("Wallet private key is invalid")]
    InvalidPrivateKey,
    #[error("Wallet keystore file already exists: {path}")]
    KeystoreAlreadyExists { path: String },
    #[error("Wallet keystore path is invalid: {path}")]
    InvalidPath { path: String },
    #[error("Wallet passphrase was rejected or the keystore is unreadable")]
    UnlockRejected,
    #[error("Wallet keystore operation failed: {message}")]
    IoFailure { message: String },
    #[error("Wallet keystore operation failed: {0}")]
    KeystoreFailure(#[from] LocalSignerError),
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOUNDRY_FIXTURE_PASSWORD: &str = "keystorepassword";
    const FOUNDRY_FIXTURE_ADDRESS: &str = "0xec554aeafe75601aaab43bd4621a22284db566c2";

    #[test]
    fn decrypts_foundry_compatible_fixture() {
        let adapter = AlloyKeystore;
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/wallet/infra/keystore/fixtures/foundry-keystore-v3.json");
        let record = WalletRecord::new(
            crate::wallet::domain::WalletMetadata::new(
                crate::wallet::domain::WalletId::new_random(),
                crate::wallet::domain::WalletLabel::parse("Fixture").unwrap(),
                crate::wallet::domain::WalletAddress::parse(FOUNDRY_FIXTURE_ADDRESS).unwrap(),
                crate::wallet::domain::now_rfc3339(),
            ),
            fixture_path,
        );

        let private_key = adapter
            .decrypt_wallet(
                &record,
                &Zeroizing::new(FOUNDRY_FIXTURE_PASSWORD.to_owned()),
            )
            .expect("fixture should decrypt");

        assert_eq!(
            record.metadata.address.normalized(),
            FOUNDRY_FIXTURE_ADDRESS.to_lowercase()
        );
        assert_eq!(private_key.as_bytes().len(), 32);
    }
}
