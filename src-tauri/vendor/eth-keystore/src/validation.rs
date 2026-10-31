//! ArtGod's bounded Ethereum V3 reader policy. Validate before allocating KDF working memory.

use scrypt::Params;

use crate::{
    EthKeystore, KdfType, KdfparamsType, KeystoreError, ARTGOD_SCRYPT_KDF_PARAMS, DEFAULT_CIPHER,
    DEFAULT_IV_SIZE, DEFAULT_KEY_SIZE, ETHEREUM_V3_DERIVED_KEY_LENGTH,
};

pub(crate) const ETHEREUM_V3_VERSION: u8 = 3;
pub(crate) const ETHEREUM_V3_MAC_LENGTH: usize = 32;
pub(crate) const PBKDF2_PRF: &str = "hmac-sha256";

/// A wallet document is normally less than 1 KiB; cap parsing and hex allocations before JSON decode.
pub const MAX_KEYSTORE_FILE_BYTES: usize = 16 * 1024;
/// Accept standard V3 salts without allowing a large PBKDF2 input buffer.
pub const MAX_KDF_SALT_BYTES: usize = 64;
/// Count SHA-256 output blocks as well as iterations when admitting PBKDF2 work.
pub const MAX_PBKDF2_BLOCK_ITERATIONS: u64 = 1_000_000;
/// Bound all three scrypt working allocations: 128 * r * (N + p + 1).
pub const MAX_SCRYPT_MEMORY_BYTES: u64 = 128
    * ARTGOD_SCRYPT_KDF_PARAMS.r as u64
    * (ARTGOD_SCRYPT_KDF_PARAMS.n as u64 + ARTGOD_SCRYPT_KDF_PARAMS.p as u64 + 1);
/// Bound scrypt CPU work independently of its memory use.
pub const MAX_SCRYPT_WORK: u64 = ARTGOD_SCRYPT_KDF_PARAMS.n as u64
    * ARTGOD_SCRYPT_KDF_PARAMS.r as u64
    * ARTGOD_SCRYPT_KDF_PARAMS.p as u64;

pub(crate) fn validate_keystore(keystore: &EthKeystore) -> Result<(), KeystoreError> {
    let crypto = &keystore.crypto;
    if keystore.version != ETHEREUM_V3_VERSION || crypto.cipher != DEFAULT_CIPHER {
        return Err(KeystoreError::InvalidKeystore(
            "unsupported version or cipher",
        ));
    }
    if crypto.cipherparams.iv.len() != DEFAULT_IV_SIZE
        || crypto.ciphertext.len() != DEFAULT_KEY_SIZE
        || crypto.mac.len() != ETHEREUM_V3_MAC_LENGTH
    {
        return Err(KeystoreError::InvalidKeystore(
            "invalid IV, ciphertext or MAC length",
        ));
    }

    match (&crypto.kdf, &crypto.kdfparams) {
        (
            KdfType::Scrypt,
            KdfparamsType::Scrypt {
                dklen,
                n,
                r,
                p,
                salt,
            },
        ) => {
            validate_kdf_input(*dklen, salt)?;
            validated_scrypt_params(*n, *r, *p)?;
        }
        (
            KdfType::Pbkdf2,
            KdfparamsType::Pbkdf2 {
                dklen,
                c,
                prf,
                salt,
            },
        ) => {
            validate_kdf_input(*dklen, salt)?;
            if prf != PBKDF2_PRF || *c == 0 {
                return Err(KeystoreError::InvalidKeystore(
                    "invalid PBKDF2 PRF or iteration count",
                ));
            }
            let blocks = u64::from(*dklen).div_ceil(u64::from(ETHEREUM_V3_DERIVED_KEY_LENGTH));
            if u64::from(*c) * blocks > MAX_PBKDF2_BLOCK_ITERATIONS {
                return Err(KeystoreError::KdfWorkLimitExceeded);
            }
        }
        _ => {
            return Err(KeystoreError::InvalidKeystore(
                "KDF label and parameters disagree",
            ))
        }
    }
    Ok(())
}

fn validate_kdf_input(dklen: u8, salt: &[u8]) -> Result<(), KeystoreError> {
    // The u8 wire type also bounds the output at 255 bytes. V3 permits dklen >= 32.
    if dklen < ETHEREUM_V3_DERIVED_KEY_LENGTH || salt.is_empty() || salt.len() > MAX_KDF_SALT_BYTES
    {
        return Err(KeystoreError::InvalidKeystore(
            "invalid derived-key or salt length",
        ));
    }
    Ok(())
}

/// Shared by the reader and parameterized writer so neither can bypass the resource policy.
pub(crate) fn validated_scrypt_params(n: u32, r: u32, p: u32) -> Result<Params, KeystoreError> {
    if n < 2 || !n.is_power_of_two() {
        return Err(KeystoreError::ScryptInvalidN(n));
    }
    let (wide_n, wide_r, wide_p) = (u64::from(n), u64::from(r), u64::from(p));
    let memory = wide_r
        .checked_mul(128)
        .and_then(|block_bytes| block_bytes.checked_mul(wide_n + wide_p + 1));
    let work = wide_n
        .checked_mul(wide_r)
        .and_then(|nr| nr.checked_mul(wide_p));
    if memory.is_none_or(|bytes| bytes > MAX_SCRYPT_MEMORY_BYTES)
        || work.is_none_or(|work| work > MAX_SCRYPT_WORK)
    {
        return Err(KeystoreError::KdfWorkLimitExceeded);
    }
    // Integer conversion is exact; RustCrypto retains ownership of algorithm parameter validity.
    Ok(Params::new(n.trailing_zeros() as u8, r, p)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_profiles_fit_both_scrypt_budgets() {
        let standard = ARTGOD_SCRYPT_KDF_PARAMS;
        assert!(validated_scrypt_params(standard.n, standard.r, standard.p).is_ok());
        // A lower-memory profile with the same N*r*p work is still admissible.
        assert!(validated_scrypt_params(131_072, 8, 2).is_ok());
    }

    #[test]
    fn invalid_or_excessive_scrypt_inputs_fail_without_allocating() {
        for n in [0, 1, 17, u32::MAX] {
            assert!(matches!(
                validated_scrypt_params(n, 8, 1),
                Err(KeystoreError::ScryptInvalidN(_))
            ));
        }
        for (n, r, p) in [(1 << 19, 8, 1), (1 << 18, 1, 9), (2, u32::MAX, u32::MAX)] {
            assert!(matches!(
                validated_scrypt_params(n, r, p),
                Err(KeystoreError::KdfWorkLimitExceeded)
            ));
        }
        assert!(validated_scrypt_params(16, 0, 1).is_err());
        assert!(validated_scrypt_params(16, 1, 0).is_err());
    }
}
