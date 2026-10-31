use std::path::Path;

use alloy_primitives::{Address, hex};
use eth_keystore::{ARTGOD_SCRYPT_KDF_PARAMS, encrypt_key_to_keystore};
#[cfg(test)]
use eth_keystore::{EthKeystore, KdfType, KdfparamsType};
use k256::SecretKey;
use k256::elliptic_curve::sec1::ToSec1Point;
use rand::thread_rng;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::private_file::write_private_file_atomic;
use crate::wallet::application::use_cases::{
    ExportWalletError, ExportWalletKeystorePort, ImportWalletError, ImportWalletKeystorePort,
    RemoveWalletError, RemoveWalletKeystorePort, UnlockWalletForBotStartError,
    UnlockWalletForBotStartKeystorePort,
};
use crate::wallet::domain::{ValidatedWalletSecret, WalletAddress, WalletPrivateKey, WalletRecord};

/// Ethereum V3 keystore adapter with an ArtGod-owned write policy.
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
        let mut raw_key = Zeroizing::new(vec![0_u8; WalletPrivateKey::BYTE_LENGTH]);
        hex::decode_to_slice(normalized, raw_key.as_mut_slice())
            .map_err(|_| AlloyKeystoreError::InvalidPrivateKey)?;
        let raw_key = WalletPrivateKey::from_bytes(raw_key)
            .map_err(|_| AlloyKeystoreError::InvalidPrivateKey)?;
        let key = SecretKey::from_slice(raw_key.as_bytes())
            .map_err(|_| AlloyKeystoreError::InvalidPrivateKey)?;
        Ok(ValidatedWalletSecret::new(wallet_address(&key), raw_key))
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
        if keystore_path.parent().is_none() {
            return Err(AlloyKeystoreError::InvalidPath {
                path: keystore_path.display().to_string(),
            });
        }
        let payload = encrypt_keystore_payload(private_key, passphrase)?;

        // Persist the encrypted document atomically with owner-only permissions.
        write_private_file_atomic(keystore_path, &payload)
            .map_err(|message| AlloyKeystoreError::IoFailure { message })
    }

    /// Decrypts a keystore file into one-shot private key material.
    pub fn decrypt_wallet(
        &self,
        wallet: &WalletRecord,
        passphrase: &Zeroizing<String>,
    ) -> Result<WalletPrivateKey, AlloyKeystoreError> {
        decrypt_wallet_key(wallet, passphrase)
    }
}

// SEC1's uncompressed public point has a one-byte format tag; Alloy owns
// Ethereum's Keccak address derivation from the remaining 64 public bytes.
fn wallet_address(key: &SecretKey) -> WalletAddress {
    let encoded = key.public_key().to_sec1_point(false);
    WalletAddress::from_alloy(Address::from_raw_public_key(&encoded.as_bytes()[1..]))
}

fn encrypt_keystore_payload(
    private_key: &WalletPrivateKey,
    passphrase: &Zeroizing<String>,
) -> Result<Vec<u8>, AlloyKeystoreError> {
    let mut rng = thread_rng();
    let keystore = encrypt_key_to_keystore(
        &mut rng,
        private_key.as_bytes(),
        passphrase.as_bytes(),
        ARTGOD_SCRYPT_KDF_PARAMS,
    )?;
    serde_json::to_vec(&keystore).map_err(|error| AlloyKeystoreError::InvalidDocument {
        message: error.to_string(),
    })
}

#[cfg(test)]
fn read_keystore_document(path: &Path) -> Result<EthKeystore, AlloyKeystoreError> {
    let payload = std::fs::read(path).map_err(|error| AlloyKeystoreError::IoFailure {
        message: format!("Failed to read wallet keystore {}: {error}", path.display()),
    })?;
    serde_json::from_slice(&payload).map_err(|error| AlloyKeystoreError::InvalidDocument {
        message: error.to_string(),
    })
}

fn decrypt_wallet_key(
    wallet: &WalletRecord,
    passphrase: &Zeroizing<String>,
) -> Result<WalletPrivateKey, AlloyKeystoreError> {
    // Take zeroizing ownership of the plaintext allocation as soon as decryption returns it.
    let private_key = eth_keystore::decrypt_key(&wallet.keystore_path, passphrase.as_bytes())
        .map(Zeroizing::new)
        .map_err(|_| AlloyKeystoreError::UnlockRejected)?;
    let private_key = WalletPrivateKey::from_bytes(private_key)
        .map_err(|_| AlloyKeystoreError::UnlockRejected)?;
    let key = SecretKey::from_slice(private_key.as_bytes())
        .map_err(|_| AlloyKeystoreError::UnlockRejected)?;

    let decrypted_address = wallet_address(&key);

    // Bind decrypted key material to the canonical wallet identity before returning it.
    if !wallet.metadata.matches_address(&decrypted_address) {
        return Err(AlloyKeystoreError::WalletAddressMismatch);
    }
    // Return the original protected allocation; serializing the scalar would create another copy.
    Ok(private_key)
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
        decrypt_wallet_key(wallet, passphrase)
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
    #[error("Wallet keystore address does not match stored wallet metadata")]
    WalletAddressMismatch,
    #[error("Wallet keystore operation failed: {message}")]
    IoFailure { message: String },
    #[error("Wallet keystore document is invalid: {message}")]
    InvalidDocument { message: String },
    #[error("Wallet keystore operation failed: {0}")]
    EthereumKeystoreFailure(#[from] eth_keystore::KeystoreError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ethereum_scalars_and_derives_known_addresses() {
        for (scalar, address) in [
            (1_u8, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
            (2_u8, "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"),
        ] {
            let mut bytes = [0_u8; 32];
            bytes[31] = scalar;
            let result = AlloyKeystore
                .validate_private_key(Zeroizing::new(hex::encode(bytes)))
                .expect("known scalar is valid");
            assert_eq!(result.address, WalletAddress::parse(address).unwrap());
            assert_eq!(result.private_key.as_bytes(), &bytes);
        }
        for key in [
            "00".repeat(32),
            "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141".to_owned(),
            "ff".repeat(32),
            "11".repeat(WalletPrivateKey::BYTE_LENGTH - 1),
            "11".repeat(WalletPrivateKey::BYTE_LENGTH + 1),
            format!("{}gg", "11".repeat(WalletPrivateKey::BYTE_LENGTH - 1)),
        ] {
            assert!(matches!(
                AlloyKeystore.validate_private_key(Zeroizing::new(key)),
                Err(AlloyKeystoreError::InvalidPrivateKey)
            ));
        }
        assert!(
            AlloyKeystore
                .validate_private_key(Zeroizing::new(
                    "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140".to_owned()
                ))
                .is_ok()
        );
    }

    const FOUNDRY_FIXTURE_PASSWORD: &str = "keystorepassword";
    const FOUNDRY_FIXTURE_ADDRESS: &str = "0xec554aeafe75601aaab43bd4621a22284db566c2";
    const MISMATCHED_FIXTURE_ADDRESS: &str = "0x0000000000000000000000000000000000000001";
    const TEST_PASSWORD: &str = "correct horse battery staple";
    const TEST_PRIVATE_KEY: [u8; 32] = [0x11; 32];

    #[test]
    fn new_keystore_uses_geth_standard_scrypt_policy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("wallet.json");
        let adapter = AlloyKeystore;

        adapter
            .write_keystore(
                &path,
                &WalletPrivateKey::from_bytes(Zeroizing::new(TEST_PRIVATE_KEY.to_vec())).unwrap(),
                &Zeroizing::new(TEST_PASSWORD.to_owned()),
            )
            .expect("keystore should be written");

        let keystore = read_keystore_document(&path).expect("keystore should parse");
        assert_scrypt_wire_params(&keystore, 32, 262_144, 8, 1);
    }

    #[test]
    fn standard_compatibility_writer_cannot_bypass_scrypt_policy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("wallet.json");

        eth_keystore::encrypt_key(
            temp_dir.path(),
            &mut thread_rng(),
            TEST_PRIVATE_KEY,
            TEST_PASSWORD.as_bytes(),
            path.file_name().and_then(|value| value.to_str()),
        )
        .expect("standard compatibility writer should encrypt");

        let keystore = read_keystore_document(&path).expect("keystore should parse");
        assert_scrypt_wire_params(&keystore, 32, 262_144, 8, 1);
    }

    #[test]
    fn decrypts_foundry_compatible_fixture_without_rewriting_it() {
        let adapter = AlloyKeystore;
        let source_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/wallet/infra/keystore/fixtures/foundry-keystore-v3.json");
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let fixture_path = temp_dir.path().join("foundry-keystore-v3.json");

        // Copy the fixture so a write regression cannot modify tracked test data.
        std::fs::copy(&source_path, &fixture_path).expect("fixture should copy");
        let original_payload = std::fs::read(&fixture_path).expect("fixture should read");
        let record = test_wallet_record(fixture_path.clone());

        let private_key = adapter
            .decrypt_wallet(
                &record,
                &Zeroizing::new(FOUNDRY_FIXTURE_PASSWORD.to_owned()),
            )
            .expect("fixture should decrypt");

        let key = SecretKey::from_slice(private_key.as_bytes())
            .expect("fixture private key should be valid");
        let decrypted_address = wallet_address(&key);
        assert!(record.metadata.matches_address(&decrypted_address));

        // Prove unlock remains a byte-for-byte read-only operation.
        let decrypted_payload = std::fs::read(fixture_path).expect("fixture should still read");
        assert_eq!(decrypted_payload, original_payload);
    }

    #[test]
    fn rejects_keystore_when_decrypted_address_differs_from_wallet_metadata() {
        let source_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/wallet/infra/keystore/fixtures/foundry-keystore-v3.json");
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let fixture_path = temp_dir.path().join("foundry-keystore-v3.json");
        std::fs::copy(source_path, &fixture_path).expect("fixture should copy");
        let record = test_wallet_record_with_address(fixture_path, MISMATCHED_FIXTURE_ADDRESS);

        let error = AlloyKeystore
            .decrypt_wallet(
                &record,
                &Zeroizing::new(FOUNDRY_FIXTURE_PASSWORD.to_owned()),
            )
            .expect_err("mismatched wallet identity should be rejected");

        assert!(matches!(error, AlloyKeystoreError::WalletAddressMismatch));
    }

    fn test_wallet_record(path: std::path::PathBuf) -> WalletRecord {
        test_wallet_record_with_address(path, FOUNDRY_FIXTURE_ADDRESS)
    }

    fn test_wallet_record_with_address(path: std::path::PathBuf, address: &str) -> WalletRecord {
        WalletRecord::new(
            crate::wallet::domain::WalletMetadata::new(
                crate::wallet::domain::WalletId::new_random(),
                crate::wallet::domain::WalletLabel::parse("Fixture").unwrap(),
                crate::wallet::domain::WalletAddress::parse(address).unwrap(),
                crate::wallet::domain::now_rfc3339(),
            ),
            path,
        )
    }

    fn assert_scrypt_wire_params(
        keystore: &EthKeystore,
        expected_dklen: u8,
        expected_n: u32,
        expected_r: u32,
        expected_p: u32,
    ) {
        assert_eq!(keystore.crypto.kdf, KdfType::Scrypt);
        let KdfparamsType::Scrypt { dklen, n, p, r, .. } = &keystore.crypto.kdfparams else {
            panic!("keystore should use scrypt parameters");
        };
        assert_eq!(
            (*dklen, *n, *r, *p),
            (expected_dklen, expected_n, expected_r, expected_p)
        );
    }
}
