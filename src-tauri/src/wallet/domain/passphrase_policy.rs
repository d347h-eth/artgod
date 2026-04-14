use thiserror::Error;

/// Enforces the minimum passphrase requirements for wallet operations.
#[derive(Clone, Debug)]
pub struct PassphrasePolicy {
    min_length: usize,
}

impl Default for PassphrasePolicy {
    fn default() -> Self {
        Self { min_length: 12 }
    }
}

impl PassphrasePolicy {
    /// Returns the minimum passphrase length enforced for wallet secrets.
    pub fn min_length(&self) -> usize {
        self.min_length
    }

    /// Validates a new passphrase and its confirmation.
    pub fn validate_new(
        &self,
        passphrase: &str,
        confirmation: &str,
    ) -> Result<(), PassphrasePolicyError> {
        self.validate_existing(passphrase)?;
        if passphrase != confirmation {
            return Err(PassphrasePolicyError::ConfirmationMismatch);
        }
        Ok(())
    }

    /// Validates a passphrase used for unlock-style operations.
    pub fn validate_existing(&self, passphrase: &str) -> Result<(), PassphrasePolicyError> {
        if passphrase.trim().is_empty() {
            return Err(PassphrasePolicyError::Empty);
        }
        if passphrase.chars().count() < self.min_length {
            return Err(PassphrasePolicyError::TooShort {
                min_length: self.min_length,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PassphrasePolicyError {
    #[error("Wallet passphrase is required")]
    Empty,
    #[error("Wallet passphrase must be at least {min_length} characters")]
    TooShort { min_length: usize },
    #[error("Wallet passphrase confirmation does not match")]
    ConfirmationMismatch,
}
