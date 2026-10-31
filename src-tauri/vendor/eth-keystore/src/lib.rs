#![cfg_attr(docsrs, feature(doc_cfg))]
//! A minimalist library to interact with encrypted JSON keystores as per the
//! [Web3 Secret Storage Definition](https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition).
// Modified by ArtGod to expose caller-selected scrypt work parameters.

use aes::{
    cipher::{self, InnerIvInit, KeyInit, StreamCipherCore},
    Aes128,
};
use digest::{Digest, Update};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::{CryptoRng, Rng};
use scrypt::scrypt;
use sha2::Sha256;
use sha3::Keccak256;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

mod error;
mod keystore;
mod utils;
mod validation;

#[cfg(feature = "geth-compat")]
use utils::geth_compat::address_from_pk;

pub use error::KeystoreError;
pub use keystore::{CipherparamsJson, CryptoJson, EthKeystore, KdfType, KdfparamsType};
use validation::{validate_keystore, validated_scrypt_params, ETHEREUM_V3_VERSION};
pub use validation::{
    MAX_KDF_SALT_BYTES, MAX_KEYSTORE_FILE_BYTES, MAX_PBKDF2_BLOCK_ITERATIONS,
    MAX_SCRYPT_MEMORY_BYTES, MAX_SCRYPT_WORK,
};

const DEFAULT_CIPHER: &str = "aes-128-ctr";
const DEFAULT_KEY_SIZE: usize = 32usize;
const DEFAULT_IV_SIZE: usize = 16usize;
const AES_KEY_SIZE: usize = 16;

/// Derived-key length required by the Ethereum V3 AES and MAC construction.
pub const ETHEREUM_V3_DERIVED_KEY_LENGTH: u8 = 32u8;

/// Caller-selected scrypt work parameters stored in an Ethereum keystore file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScryptKdfParams {
    /// CPU and memory cost, expressed as a non-zero power of two.
    pub n: u32,
    /// Scrypt block-size parameter.
    pub r: u32,
    /// Scrypt parallelization parameter.
    pub p: u32,
}

impl ScryptKdfParams {
    /// Creates an explicit scrypt work-parameter set for keystore encryption.
    pub const fn new(n: u32, r: u32, p: u32) -> Self {
        Self { n, r, p }
    }
}

/// Production scrypt work policy for every ArtGod keystore writer path.
pub const ARTGOD_SCRYPT_KDF_PARAMS: ScryptKdfParams = ScryptKdfParams::new(1 << 18, 8, 1);

/// Creates a new JSON keystore using the [Scrypt](https://tools.ietf.org/html/rfc7914.html)
/// key derivation function. The keystore is encrypted by a key derived from the provided `password`
/// and stored in the provided directory with either the user-provided filename, or a generated
/// Uuid `id`.
///
/// # Example
///
/// ```no_run
/// use eth_keystore::new;
/// use std::path::Path;
///
/// # async fn foobar() -> Result<(), Box<dyn std::error::Error>> {
/// let dir = Path::new("./keys");
/// let mut rng = rand::thread_rng();
/// // here `None` signifies we don't specify a filename for the keystore.
/// // the default filename is a generated Uuid for the keystore.
/// let (private_key, name) = new(&dir, &mut rng, "password_to_keystore", None)?;
///
/// // here `Some("my_key")` denotes a custom filename passed by the caller.
/// let (private_key, name) = new(&dir, &mut rng, "password_to_keystore", Some("my_key"))?;
/// # Ok(())
/// # }
/// ```
pub fn new<P, R, S>(
    dir: P,
    rng: &mut R,
    password: S,
    name: Option<&str>,
) -> Result<(Vec<u8>, String), KeystoreError>
where
    P: AsRef<Path>,
    R: Rng + CryptoRng,
    S: AsRef<[u8]>,
{
    // Generate a random private key.
    let mut pk = vec![0u8; DEFAULT_KEY_SIZE];
    rng.fill_bytes(pk.as_mut_slice());

    let name = encrypt_key(dir, rng, &pk, password, name)?;
    Ok((pk, name))
}

/// Decrypts an encrypted JSON keystore at the provided `path` using the provided `password`.
/// Decryption supports the [Scrypt](https://tools.ietf.org/html/rfc7914.html) and
/// [PBKDF2](https://ietf.org/rfc/rfc2898.txt) key derivation functions.
///
/// # Example
///
/// ```no_run
/// use eth_keystore::decrypt_key;
/// use std::path::Path;
///
/// # async fn foobar() -> Result<(), Box<dyn std::error::Error>> {
/// let keypath = Path::new("./keys/my-key");
/// let private_key = decrypt_key(&keypath, "password_to_keystore")?;
/// # Ok(())
/// # }
/// ```
pub fn decrypt_key<P, S>(path: P, password: S) -> Result<Vec<u8>, KeystoreError>
where
    P: AsRef<Path>,
    S: AsRef<[u8]>,
{
    // Bound the actual read, including a growing file, before JSON or hex decoding allocates.
    let file = File::open(path)?;
    let mut contents = Vec::new();
    file.take((MAX_KEYSTORE_FILE_BYTES + 1) as u64)
        .read_to_end(&mut contents)?;
    if contents.len() > MAX_KEYSTORE_FILE_BYTES {
        return Err(KeystoreError::DocumentTooLarge);
    }
    let keystore: EthKeystore = serde_json::from_slice(&contents)?;
    decrypt_keystore(keystore, password.as_ref())
}

fn decrypt_keystore(keystore: EthKeystore, password: &[u8]) -> Result<Vec<u8>, KeystoreError> {
    // All metadata, lengths and resource limits must pass before any KDF runs.
    validate_keystore(&keystore)?;

    // Derive the key.
    let key = match keystore.crypto.kdfparams {
        KdfparamsType::Pbkdf2 {
            c,
            dklen,
            prf: _,
            salt,
        } => {
            let mut key = Zeroizing::new(vec![0u8; dklen as usize]);
            pbkdf2::<Hmac<Sha256>>(password, &salt, c, key.as_mut_slice());
            key
        }
        KdfparamsType::Scrypt {
            dklen,
            n,
            p,
            r,
            salt,
        } => {
            let mut key = Zeroizing::new(vec![0u8; dklen as usize]);
            let scrypt_params = validated_scrypt_params(n, r, p)?;
            scrypt(password, &salt, &scrypt_params, key.as_mut_slice())?;
            key
        }
    };

    // Derive the MAC from the derived key and ciphertext.
    let derived_mac = Keccak256::new()
        .chain(&key[AES_KEY_SIZE..usize::from(ETHEREUM_V3_DERIVED_KEY_LENGTH)])
        .chain(&keystore.crypto.ciphertext)
        .finalize();

    if !bool::from(derived_mac.as_slice().ct_eq(keystore.crypto.mac.as_slice())) {
        return Err(KeystoreError::MacMismatch);
    }

    // Decrypt the private key bytes using AES-128-CTR
    let decryptor = Aes128Ctr::new(&key[..AES_KEY_SIZE], &keystore.crypto.cipherparams.iv)?;

    let mut pk = keystore.crypto.ciphertext;
    decryptor.apply_keystream(&mut pk);

    Ok(pk)
}

/// Encrypts the given private key using the [Scrypt](https://tools.ietf.org/html/rfc7914.html)
/// password-based key derivation function, and stores it in the provided directory. On success, it
/// returns the `id` (Uuid) generated for this keystore.
///
/// # Example
///
/// ```no_run
/// use eth_keystore::encrypt_key;
/// use rand::RngCore;
/// use std::path::Path;
///
/// # async fn foobar() -> Result<(), Box<dyn std::error::Error>> {
/// let dir = Path::new("./keys");
/// let mut rng = rand::thread_rng();
///
/// // Construct a 32-byte random private key.
/// let mut private_key = vec![0u8; 32];
/// rng.fill_bytes(private_key.as_mut_slice());
///
/// // Since we specify a custom filename for the keystore, it will be stored in `$dir/my-key`
/// let name = encrypt_key(&dir, &mut rng, &private_key, "password_to_keystore", Some("my-key"))?;
/// # Ok(())
/// # }
/// ```
pub fn encrypt_key<P, R, B, S>(
    dir: P,
    rng: &mut R,
    pk: B,
    password: S,
    name: Option<&str>,
) -> Result<String, KeystoreError>
where
    P: AsRef<Path>,
    R: Rng + CryptoRng,
    B: AsRef<[u8]>,
    S: AsRef<[u8]>,
{
    let keystore = encrypt_key_to_keystore(rng, pk, password, ARTGOD_SCRYPT_KDF_PARAMS)?;
    let id = keystore.id;
    let name = if let Some(name) = name {
        name.to_string()
    } else {
        id.to_string()
    };
    let contents = serde_json::to_string(&keystore)?;

    // Create a file in write-only mode, to store the encrypted JSON keystore.
    let mut file = File::create(dir.as_ref().join(&name))?;
    file.write_all(contents.as_bytes())?;

    Ok(id.to_string())
}

/// Encrypts a private key into an in-memory Ethereum V3 keystore with explicit scrypt parameters.
pub fn encrypt_key_to_keystore<R, B, S>(
    rng: &mut R,
    pk: B,
    password: S,
    scrypt_params: ScryptKdfParams,
) -> Result<EthKeystore, KeystoreError>
where
    R: Rng + CryptoRng,
    B: AsRef<[u8]>,
    S: AsRef<[u8]>,
{
    let pk = pk.as_ref();
    if pk.len() != DEFAULT_KEY_SIZE {
        return Err(KeystoreError::InvalidKeystore("invalid private-key length"));
    }
    let rust_crypto_params =
        validated_scrypt_params(scrypt_params.n, scrypt_params.r, scrypt_params.p)?;

    // Generate a random salt for this keystore artifact.
    let mut salt = vec![0u8; DEFAULT_KEY_SIZE];
    rng.fill_bytes(salt.as_mut_slice());

    // Derive the encryption and MAC key with the caller-owned work policy.
    let mut key = Zeroizing::new(vec![0u8; ETHEREUM_V3_DERIVED_KEY_LENGTH as usize]);
    scrypt(
        password.as_ref(),
        &salt,
        &rust_crypto_params,
        key.as_mut_slice(),
    )?;

    // Encrypt the private key using the Ethereum V3 AES-128-CTR construction.
    let mut iv = vec![0u8; DEFAULT_IV_SIZE];
    rng.fill_bytes(iv.as_mut_slice());
    let encryptor = Aes128Ctr::new(&key[..AES_KEY_SIZE], &iv)?;
    let mut ciphertext = pk.to_vec();
    encryptor.apply_keystream(&mut ciphertext);

    // Authenticate the ciphertext with the Ethereum V3 Keccak MAC construction.
    let mac = Keccak256::new()
        .chain(&key[AES_KEY_SIZE..usize::from(ETHEREUM_V3_DERIVED_KEY_LENGTH)])
        .chain(&ciphertext)
        .finalize();

    Ok(EthKeystore {
        id: Uuid::new_v4(),
        version: ETHEREUM_V3_VERSION,
        crypto: CryptoJson {
            cipher: String::from(DEFAULT_CIPHER),
            cipherparams: CipherparamsJson { iv },
            ciphertext,
            kdf: KdfType::Scrypt,
            kdfparams: KdfparamsType::Scrypt {
                dklen: ETHEREUM_V3_DERIVED_KEY_LENGTH,
                n: scrypt_params.n,
                p: scrypt_params.p,
                r: scrypt_params.r,
                salt,
            },
            mac: mac.to_vec(),
        },
        #[cfg(feature = "geth-compat")]
        address: address_from_pk(pk)?,
    })
}

struct Aes128Ctr {
    inner: ctr::CtrCore<Aes128, ctr::flavors::Ctr128BE>,
}

impl Aes128Ctr {
    fn new(key: &[u8], iv: &[u8]) -> Result<Self, cipher::InvalidLength> {
        let cipher = aes::Aes128::new_from_slice(key)?;
        let inner = ctr::CtrCore::inner_iv_slice_init(cipher, iv)?;
        Ok(Self { inner })
    }

    fn apply_keystream(self, buf: &mut [u8]) {
        self.inner.apply_keystream_partial(buf.into());
    }
}

#[cfg(test)]
mod security_tests;

#[cfg(test)]
mod explicit_scrypt_tests {
    use super::*;

    #[test]
    fn in_memory_writer_preserves_explicit_scrypt_parameters() {
        let params = ScryptKdfParams::new(1 << 4, 8, 1);
        let keystore = encrypt_key_to_keystore(
            &mut rand::thread_rng(),
            [0x11; 32],
            b"test password",
            params,
        )
        .expect("explicit scrypt parameters should encrypt");

        let KdfparamsType::Scrypt { dklen, n, p, r, .. } = keystore.crypto.kdfparams else {
            panic!("writer should emit scrypt parameters");
        };
        assert_eq!(
            (dklen, n, r, p),
            (ETHEREUM_V3_DERIVED_KEY_LENGTH, params.n, params.r, params.p)
        );
    }

    #[test]
    fn in_memory_writer_rejects_non_power_of_two_n() {
        let error = encrypt_key_to_keystore(
            &mut rand::thread_rng(),
            [0x11; 32],
            b"test password",
            ScryptKdfParams::new(12, 8, 1),
        )
        .expect_err("invalid N should be rejected");

        assert!(matches!(error, KeystoreError::ScryptInvalidN(12)));
    }
}
