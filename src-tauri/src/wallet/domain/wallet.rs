use std::fmt::{self, Write};
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

    /// Returns true when the wallet is assigned to the given bot kind.
    pub fn is_assigned_to_bot(&self, bot_kind: BotKind) -> bool {
        self.assigned_bot_kinds.contains(&bot_kind)
    }

    /// Returns true when the wallet is assigned to any bot runtime.
    pub fn has_bot_assignment(&self) -> bool {
        !self.assigned_bot_kinds.is_empty()
    }

    /// Returns a cloned metadata record with the provided bot assignments and updated timestamp.
    pub fn with_assigned_bot_kinds(
        &self,
        assigned_bot_kinds: Vec<BotKind>,
        updated_at: String,
    ) -> Self {
        let mut next = self.clone();
        next.assigned_bot_kinds = assigned_bot_kinds;
        next.updated_at = updated_at;
        next
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

/// Redacted, fixed-length private key whose protected heap allocation survives ownership moves.
pub struct WalletPrivateKey(Zeroizing<Vec<u8>>);

impl WalletPrivateKey {
    /// Width of an Ethereum private key, including leading zero bytes.
    pub const BYTE_LENGTH: usize = 32;

    /// Takes ownership without copying plaintext through an unprotected array.
    /// Scalar validity is checked by the keystore adapter before use.
    pub fn from_bytes(bytes: Zeroizing<Vec<u8>>) -> Result<Self, WalletDomainError> {
        if bytes.len() != Self::BYTE_LENGTH {
            return Err(WalletDomainError::InvalidPrivateKeyLength);
        }
        Ok(Self(bytes))
    }

    /// Returns a borrowed view of the raw key bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// Encodes a native export directly into its final protected allocation.
    pub fn to_prefixed_hex(&self) -> Zeroizing<String> {
        const PREFIX: &str = "0x";
        let hex_length = Self::BYTE_LENGTH * 2;
        let mut encoded = Zeroizing::new(String::with_capacity(PREFIX.len() + hex_length));
        encoded.push_str(PREFIX);
        // Capacity is fixed before writing secrets; formatting directly avoids temporary hex strings.
        for byte in self.as_bytes() {
            write!(&mut *encoded, "{byte:02x}").expect("writing to a String is infallible");
        }
        encoded
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
    /// Pairs the derived identity with its already-protected key owner.
    pub fn new(address: WalletAddress, private_key: WalletPrivateKey) -> Self {
        Self {
            address,
            private_key,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WalletDomainError {
    #[error("Wallet private key must contain exactly 32 bytes")]
    InvalidPrivateKeyLength,
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

#[cfg(test)]
mod private_key_tests {
    use super::*;

    #[test]
    fn taking_key_ownership_preserves_the_protected_allocation() {
        let bytes = Zeroizing::new(vec![0xa5; WalletPrivateKey::BYTE_LENGTH]);
        let allocation = bytes.as_ptr();
        let key = WalletPrivateKey::from_bytes(bytes).unwrap();
        let validated = ValidatedWalletSecret::new(
            WalletAddress::parse("0x0000000000000000000000000000000000000001").unwrap(),
            key,
        );
        assert_eq!(validated.private_key.as_bytes().as_ptr(), allocation);
        assert!(!format!("{validated:?}").contains(&"a5".repeat(WalletPrivateKey::BYTE_LENGTH)));
    }

    #[test]
    fn export_preserves_prefix_width_and_leading_zeros() {
        let mut bytes = Zeroizing::new(vec![0; WalletPrivateKey::BYTE_LENGTH]);
        bytes[WalletPrivateKey::BYTE_LENGTH - 1] = 1;
        let key = WalletPrivateKey::from_bytes(bytes).unwrap();
        assert_eq!(
            key.to_prefixed_hex().as_str(),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(key.as_bytes()[WalletPrivateKey::BYTE_LENGTH - 1], 1);
    }

    #[test]
    fn key_owners_reject_noncanonical_byte_lengths() {
        for length in [
            0,
            24,
            WalletPrivateKey::BYTE_LENGTH - 1,
            WalletPrivateKey::BYTE_LENGTH + 1,
        ] {
            assert_eq!(
                WalletPrivateKey::from_bytes(Zeroizing::new(vec![1; length])).unwrap_err(),
                WalletDomainError::InvalidPrivateKeyLength
            );
        }
    }
}
