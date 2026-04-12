use std::fmt;
use std::path::{Path, PathBuf};

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;
use zeroize::Zeroizing;

const WALLET_LABEL_MAX_LENGTH: usize = 120;
const ETHEREUM_KEYSTORE_VERSION: u8 = 3;

/// Returns the current UTC timestamp in RFC 3339 format.
pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC 3339 formatter should always be valid")
}

/// Stable wallet identifier used for metadata and keystore file names.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WalletId(String);

impl WalletId {
    /// Creates a new random wallet identifier.
    pub fn new_random() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Parses a wallet identifier from persisted storage or transport input.
    pub fn parse(raw: impl AsRef<str>) -> Result<Self, WalletDomainError> {
        let trimmed = raw.as_ref().trim();
        if trimmed.is_empty() {
            return Err(WalletDomainError::InvalidWalletId);
        }
        let parsed = Uuid::parse_str(trimmed).map_err(|_| WalletDomainError::InvalidWalletId)?;
        Ok(Self(parsed.to_string()))
    }

    /// Returns the canonical wallet identifier string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the canonical keystore file name for the wallet.
    pub fn keystore_file_name(&self) -> String {
        format!("{}.json", self.0)
    }

    /// Returns the temporary removal file name used during rollback-safe deletes.
    pub fn pending_removal_file_name(&self) -> String {
        format!("{}.json.removing", self.0)
    }

    /// Parses the wallet id from a pending removal file name.
    pub fn from_pending_removal_file_name(file_name: &str) -> Option<Self> {
        let raw = file_name.strip_suffix(".json.removing")?;
        Self::parse(raw).ok()
    }
}

impl fmt::Display for WalletId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Operator-visible wallet label shown in the admin UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WalletLabel(String);

impl WalletLabel {
    /// Validates and normalizes a wallet label for storage.
    pub fn parse(raw: impl AsRef<str>) -> Result<Self, WalletDomainError> {
        let trimmed = raw.as_ref().trim();
        if trimmed.is_empty() {
            return Err(WalletDomainError::EmptyWalletLabel);
        }
        if trimmed.chars().count() > WALLET_LABEL_MAX_LENGTH {
            return Err(WalletDomainError::WalletLabelTooLong {
                max_length: WALLET_LABEL_MAX_LENGTH,
            });
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// Returns the label exactly as it should be displayed.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the normalized comparison key for uniqueness checks.
    pub fn normalized(&self) -> String {
        self.0.to_lowercase()
    }
}

impl fmt::Display for WalletLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Canonical EVM address associated with a stored wallet.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WalletAddress(String);

impl WalletAddress {
    /// Parses and validates a wallet address string.
    pub fn parse(raw: impl AsRef<str>) -> Result<Self, WalletDomainError> {
        let parsed = raw
            .as_ref()
            .trim()
            .parse::<Address>()
            .map_err(|_| WalletDomainError::InvalidWalletAddress)?;
        Ok(Self::from_alloy(parsed))
    }

    /// Creates a wallet address from an Alloy address value.
    pub fn from_alloy(address: Address) -> Self {
        Self(address.to_string())
    }

    /// Returns the persisted address string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the normalized comparison key for uniqueness checks.
    pub fn normalized(&self) -> String {
        self.0.to_lowercase()
    }
}

impl fmt::Display for WalletAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Supported wallet-bound bot kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotKind {
    Bidding,
    Sniping,
}

/// Storage format marker for the wallet index file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletStorageFormat {
    EthereumKeystoreV3,
}

/// Persisted non-secret wallet status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletStatus {
    Stored,
}

/// Non-secret wallet metadata stored in the wallet index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletMetadata {
    pub wallet_id: WalletId,
    pub label: WalletLabel,
    pub address: WalletAddress,
    pub created_at: String,
    pub updated_at: String,
    pub keystore_version: u8,
    pub storage_format: WalletStorageFormat,
    pub assigned_bot_kinds: Vec<BotKind>,
    pub status: WalletStatus,
}

impl WalletMetadata {
    /// Creates a new metadata record for a just-imported wallet.
    pub fn new(
        wallet_id: WalletId,
        label: WalletLabel,
        address: WalletAddress,
        now: String,
    ) -> Self {
        Self {
            wallet_id,
            label,
            address,
            created_at: now.clone(),
            updated_at: now,
            keystore_version: ETHEREUM_KEYSTORE_VERSION,
            storage_format: WalletStorageFormat::EthereumKeystoreV3,
            assigned_bot_kinds: Vec::new(),
            status: WalletStatus::Stored,
        }
    }

    /// Checks whether a wallet label matches under the canonical uniqueness rule.
    pub fn matches_label(&self, label: &WalletLabel) -> bool {
        self.label.normalized() == label.normalized()
    }

    /// Checks whether a wallet address matches under the canonical uniqueness rule.
    pub fn matches_address(&self, address: &WalletAddress) -> bool {
        self.address.normalized() == address.normalized()
    }
}

/// Full wallet record combining metadata with the keystore file path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletRecord {
    pub metadata: WalletMetadata,
    pub keystore_path: PathBuf,
}

impl WalletRecord {
    /// Creates a wallet record from metadata plus its keystore path.
    pub fn new(metadata: WalletMetadata, keystore_path: PathBuf) -> Self {
        Self {
            metadata,
            keystore_path,
        }
    }
}

/// Redacted wrapper around raw 32-byte private key material.
pub struct WalletPrivateKey(Zeroizing<[u8; 32]>);

impl WalletPrivateKey {
    /// Creates a private key wrapper from raw key bytes.
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Returns a borrowed view of the raw key bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Consumes the wrapper and returns the owned zeroizing buffer.
    pub fn into_zeroizing_bytes(self) -> Zeroizing<[u8; 32]> {
        self.0
    }
}

impl fmt::Debug for WalletPrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WalletPrivateKey")
            .field("len", &self.0.len())
            .finish()
    }
}

/// Private-key material after validation or decrypt, paired with the derived address.
#[derive(Debug)]
pub struct ValidatedWalletSecret {
    pub address: WalletAddress,
    pub private_key: WalletPrivateKey,
}

impl ValidatedWalletSecret {
    /// Creates validated secret material from address and raw key bytes.
    pub fn new(address: WalletAddress, private_key: [u8; 32]) -> Self {
        Self {
            address,
            private_key: WalletPrivateKey::new(private_key),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WalletDomainError {
    #[error("Wallet id is invalid")]
    InvalidWalletId,
    #[error("Wallet label is required")]
    EmptyWalletLabel,
    #[error("Wallet address is invalid")]
    InvalidWalletAddress,
    #[error("Wallet label must be at most {max_length} characters")]
    WalletLabelTooLong { max_length: usize },
}

/// Resolves the wallet record path from a wallet directory.
pub fn keystore_path_for(wallet_dir: &Path, wallet_id: &WalletId) -> PathBuf {
    wallet_dir.join(wallet_id.keystore_file_name())
}
