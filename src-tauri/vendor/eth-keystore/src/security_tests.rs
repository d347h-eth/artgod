use super::*;
use serde_json::{json, Value};

const PASSWORD: &[u8] = b"public test passphrase";
const PRIVATE_KEY: [u8; DEFAULT_KEY_SIZE] = [0x11; DEFAULT_KEY_SIZE];
const PBKDF2_FIXTURE: &str = include_str!("../tests/fixtures/ethereum-pbkdf2-v3.json");

fn fixture() -> Value {
    // Cheap work is confined to public test material; production writers use the owned policy.
    serde_json::to_value(
        encrypt_key_to_keystore(
            &mut rand::thread_rng(),
            PRIVATE_KEY,
            PASSWORD,
            ScryptKdfParams::new(16, 8, 1),
        )
        .unwrap(),
    )
    .unwrap()
}

fn decrypt(value: Value, password: &[u8]) -> Result<Vec<u8>, KeystoreError> {
    decrypt_keystore(serde_json::from_value(value)?, password)
}

#[test]
fn aes_key_schedule_is_zeroized_on_drop() {
    fn require_zeroizing_drop<T: zeroize::ZeroizeOnDrop>() {}
    require_zeroizing_drop::<Aes128>();
}

#[test]
fn valid_roundtrip_wrong_password_and_each_mac_byte_are_checked() {
    let document = fixture();
    assert_eq!(decrypt(document.clone(), PASSWORD).unwrap(), PRIVATE_KEY);
    assert!(matches!(
        decrypt(document.clone(), b"wrong password"),
        Err(KeystoreError::MacMismatch)
    ));
    let mac = hex::decode(document["crypto"]["mac"].as_str().unwrap()).unwrap();
    for index in 0..validation::ETHEREUM_V3_MAC_LENGTH {
        let mut changed_mac = mac.clone();
        changed_mac[index] ^= 1;
        let mut changed_document = document.clone();
        changed_document["crypto"]["mac"] = hex::encode(changed_mac).into();
        assert!(matches!(
            decrypt(changed_document, PASSWORD),
            Err(KeystoreError::MacMismatch)
        ));
    }
    let mut changed_document = document;
    changed_document["crypto"]["ciphertext"] = hex::encode([0; DEFAULT_KEY_SIZE]).into();
    assert!(matches!(
        decrypt(changed_document, PASSWORD),
        Err(KeystoreError::MacMismatch)
    ));
}

#[test]
fn malformed_metadata_fails_before_kdf_or_cipher_use() {
    let document = fixture();
    let mut cases = vec![
        ("/version", json!(4)),
        ("/crypto/cipher", json!("not-a-cipher")),
        ("/crypto/kdf", json!("pbkdf2")),
        ("/crypto/kdfparams/n", json!(0)),
        ("/crypto/kdfparams/n", json!(1)),
        ("/crypto/kdfparams/n", json!(17)),
        ("/crypto/kdfparams/n", json!(262_145)),
        ("/crypto/kdfparams/n", json!(1_u32 << 31)),
        ("/crypto/kdfparams/r", json!(0)),
        ("/crypto/kdfparams/p", json!(0)),
        ("/crypto/kdfparams/p", json!(u32::MAX)),
        ("/crypto/kdfparams/salt", json!("")),
        (
            "/crypto/kdfparams/salt",
            json!("11".repeat(MAX_KDF_SALT_BYTES + 1)),
        ),
    ];
    for length in [0, 16, 31] {
        cases.push(("/crypto/kdfparams/dklen", json!(length)));
    }
    for (pointer, width) in [
        ("/crypto/cipherparams/iv", DEFAULT_IV_SIZE),
        ("/crypto/ciphertext", DEFAULT_KEY_SIZE),
        ("/crypto/mac", validation::ETHEREUM_V3_MAC_LENGTH),
    ] {
        for length in [0, width - 1, width + 1] {
            cases.push((pointer, json!("11".repeat(length))));
        }
    }
    for (pointer, value) in cases {
        let mut changed = document.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let error = decrypt(changed, PASSWORD).expect_err(pointer);
        // A MAC mismatch would show that invalid metadata reached the expensive derivation.
        assert!(!matches!(error, KeystoreError::MacMismatch), "{pointer}");
    }
}

#[test]
fn ambiguous_kdf_parameter_shapes_are_rejected() {
    let mut document = fixture();
    document["crypto"]["kdfparams"]["c"] = json!(1);
    document["crypto"]["kdfparams"]["prf"] = json!(validation::PBKDF2_PRF);
    assert!(serde_json::from_value::<EthKeystore>(document).is_err());
}

#[test]
fn published_ethereum_pbkdf2_vector_remains_compatible() {
    let document: EthKeystore = serde_json::from_str(PBKDF2_FIXTURE).unwrap();
    assert_eq!(
        hex::encode(decrypt_keystore(document, b"testpassword").unwrap()),
        "7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d"
    );
}

#[test]
fn pbkdf2_policy_checks_prf_iterations_and_total_output_work() {
    for (pointer, value) in [
        ("/crypto/kdfparams/prf", json!("hmac-sha1")),
        ("/crypto/kdfparams/c", json!(0)),
        (
            "/crypto/kdfparams/c",
            json!(MAX_PBKDF2_BLOCK_ITERATIONS + 1),
        ),
    ] {
        let mut document: Value = serde_json::from_str(PBKDF2_FIXTURE).unwrap();
        *document.pointer_mut(pointer).unwrap() = value;
        assert!(validate_keystore(&serde_json::from_value(document).unwrap()).is_err());
    }
    let mut document: Value = serde_json::from_str(PBKDF2_FIXTURE).unwrap();
    document["crypto"]["kdfparams"]["dklen"] = json!(64);
    document["crypto"]["kdfparams"]["c"] = json!(MAX_PBKDF2_BLOCK_ITERATIONS / 2);
    assert!(validate_keystore(&serde_json::from_value(document.clone()).unwrap()).is_ok());
    document["crypto"]["kdfparams"]["c"] = json!(MAX_PBKDF2_BLOCK_ITERATIONS / 2 + 1);
    assert!(matches!(
        validate_keystore(&serde_json::from_value(document).unwrap()),
        Err(KeystoreError::KdfWorkLimitExceeded)
    ));
}
