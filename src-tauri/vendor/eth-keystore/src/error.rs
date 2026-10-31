// Modified by ArtGod to validate caller-selected scrypt work parameters.
use thiserror::Error;

#[derive(Error, Debug)]
/// An error thrown when interacting with the eth-keystore crate.
pub enum KeystoreError {
    /// A wallet file exceeded the bounded reader's allocation budget.
    #[error("Keystore document exceeds the size limit")]
    DocumentTooLarge,
    /// Unsupported or inconsistent Ethereum V3 fields. Never contains secret input.
    #[error("Invalid keystore: {0}")]
    InvalidKeystore(&'static str),
    /// KDF parameters exceed the locally supported memory or CPU budget.
    #[error("Keystore KDF exceeds the work limit")]
    KdfWorkLimitExceeded,
    /// An error thrown while decrypting an encrypted JSON keystore if the calculated MAC does not
    /// match the MAC declared in the keystore.
    #[error("Mac Mismatch")]
    MacMismatch,
    /// An error thrown by the Rust `std::io` module.
    #[error("IO: {0}")]
    StdIo(String),
    /// An error thrown by the [Serde JSON](https://docs.serde.rs/serde_json/) crate.
    #[error("serde-json: {0}")]
    SerdeJson(String),
    /// Invalid scrypt output length
    #[error("scrypt {0:?}")]
    ScryptInvalidParams(scrypt::errors::InvalidParams),
    /// Invalid scrypt output length
    #[error("scrypt {0:?}")]
    ScryptInvalidOuputLen(scrypt::errors::InvalidOutputLen),
    /// Scrypt's CPU and memory cost must be a power of two greater than one.
    #[error("scrypt N must be a power of two greater than one: {0}")]
    ScryptInvalidN(u32),
    /// Invalid aes key nonce length
    #[error("aes {0:?}")]
    AesInvalidKeyNonceLength(aes::cipher::InvalidLength),

    /// Error propagated from k256 crate
    #[cfg(feature = "geth-compat")]
    #[error(transparent)]
    K256Error(#[from] k256::ecdsa::Error),
}

impl From<scrypt::errors::InvalidParams> for KeystoreError {
    fn from(e: scrypt::errors::InvalidParams) -> Self {
        Self::ScryptInvalidParams(e)
    }
}

impl From<scrypt::errors::InvalidOutputLen> for KeystoreError {
    fn from(e: scrypt::errors::InvalidOutputLen) -> Self {
        Self::ScryptInvalidOuputLen(e)
    }
}

impl From<aes::cipher::InvalidLength> for KeystoreError {
    fn from(e: aes::cipher::InvalidLength) -> Self {
        Self::AesInvalidKeyNonceLength(e)
    }
}

impl From<std::io::Error> for KeystoreError {
    fn from(e: std::io::Error) -> KeystoreError {
        KeystoreError::StdIo(e.to_string())
    }
}

impl From<serde_json::Error> for KeystoreError {
    fn from(e: serde_json::Error) -> KeystoreError {
        KeystoreError::SerdeJson(e.to_string())
    }
}
