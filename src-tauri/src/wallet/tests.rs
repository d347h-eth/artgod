use std::sync::Arc;

use alloy_primitives::hex;
use tempfile::TempDir;
use zeroize::Zeroizing;

use crate::wallet::application::use_cases::{
    AssignWalletToBot, AssignWalletToBotInput, ExportWallet, ExportWalletError, ExportWalletInput,
    ImportWallet, ImportWalletError, ImportWalletInput, ListWallets, RemoveWallet,
    RemoveWalletError, RemoveWalletInput, UnlockWalletForBotStart, UnlockWalletForBotStartInput,
};
use crate::wallet::domain::{BotKind, PassphrasePolicy};
use crate::wallet::infra::keystore::AlloyKeystore;
use crate::wallet::infra::storage::FsWalletStore;

const TEST_PRIVATE_KEY_ONE: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_PRIVATE_KEY_TWO: &str =
    "0x59c6995e998f97a5a0044966f094538e44d7c6b9ddf06f80f2e6d7a5649c0d8b";
const TEST_PASSPHRASE: &str = "correct horse battery staple";

struct TestWalletStack {
    _temp_dir: TempDir,
    store: Arc<FsWalletStore>,
    keystore: Arc<AlloyKeystore>,
}

fn build_wallet_stack() -> TestWalletStack {
    let temp_dir = tempfile::tempdir().unwrap();
    let wallet_dir = temp_dir.path().join("wallets");
    let store = FsWalletStore::new(wallet_dir).unwrap();
    TestWalletStack {
        _temp_dir: temp_dir,
        store: Arc::new(store),
        keystore: Arc::new(AlloyKeystore),
    }
}

#[test]
fn keystore_roundtrip_and_list_flow_work() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );
    let list_wallets = ListWallets::new(stack.store.clone());
    let export_wallet = ExportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );

    let metadata = import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    assert!(stack.store.keystore_path(&metadata.wallet_id).exists());

    let listed = list_wallets.execute().unwrap();
    assert_eq!(listed.wallets.len(), 1);
    assert_eq!(listed.wallets[0].label.as_str(), "Primary");

    let exported = export_wallet
        .execute(ExportWalletInput {
            wallet_id: metadata.wallet_id.clone(),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    assert_eq!(
        exported.metadata.address.as_str(),
        metadata.address.as_str()
    );
    assert_eq!(
        format!("0x{}", hex::encode(exported.private_key.as_bytes())),
        TEST_PRIVATE_KEY_ONE
    );
}

#[test]
fn wrong_passphrase_is_rejected() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );
    let export_wallet = ExportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );

    let metadata = import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    let error = export_wallet
        .execute(ExportWalletInput {
            wallet_id: metadata.wallet_id,
            passphrase: Zeroizing::new("definitely wrong".to_owned()),
        })
        .unwrap_err();

    assert_eq!(error, ExportWalletError::UnlockRejected);
}

#[test]
fn duplicate_address_is_rejected() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );

    import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    let error = import_wallet
        .execute(ImportWalletInput {
            label: "Backup".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap_err();

    assert!(matches!(error, ImportWalletError::DuplicateAddress { .. }));
}

#[test]
fn duplicate_label_is_rejected_case_insensitively() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );

    import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    let error = import_wallet
        .execute(ImportWalletInput {
            label: "primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_TWO.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap_err();

    assert_eq!(
        error,
        ImportWalletError::DuplicateLabel {
            label: "primary".to_owned()
        }
    );
}

#[test]
fn remove_rolls_back_keystore_when_index_write_fails() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );
    let remove_wallet = RemoveWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );

    let metadata = import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    let keystore_path = stack.store.keystore_path(&metadata.wallet_id);
    stack.store.fail_next_atomic_write_for_test();

    let error = remove_wallet
        .execute(RemoveWalletInput {
            wallet_id: metadata.wallet_id.clone(),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap_err();

    assert!(matches!(error, RemoveWalletError::StorageFailure { .. }));
    assert!(keystore_path.exists());
    assert_eq!(stack.store.list_wallets().unwrap().len(), 1);
}

#[test]
fn unlock_for_bot_start_returns_secret_once() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );
    let unlock_wallet = UnlockWalletForBotStart::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );

    let metadata = import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_TWO.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    let unlocked = unlock_wallet
        .execute(UnlockWalletForBotStartInput {
            wallet_id: metadata.wallet_id,
            bot_kind: BotKind::Bidding,
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    assert_eq!(unlocked.bot_kind, BotKind::Bidding);
    assert_eq!(
        format!("0x{}", hex::encode(unlocked.private_key.as_bytes())),
        TEST_PRIVATE_KEY_TWO
    );
}

#[test]
fn assign_wallet_to_bot_reassigns_and_clears_prior_owner() {
    let stack = build_wallet_stack();
    let import_wallet = ImportWallet::new(
        stack.store.clone(),
        stack.keystore.clone(),
        PassphrasePolicy::default(),
    );
    let assign_wallet = AssignWalletToBot::new(stack.store.clone());
    let list_wallets = ListWallets::new(stack.store.clone());

    let first_wallet = import_wallet
        .execute(ImportWalletInput {
            label: "Primary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_ONE.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();
    let second_wallet = import_wallet
        .execute(ImportWalletInput {
            label: "Secondary".to_owned(),
            private_key: Zeroizing::new(TEST_PRIVATE_KEY_TWO.to_owned()),
            passphrase: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
            passphrase_confirmation: Zeroizing::new(TEST_PASSPHRASE.to_owned()),
        })
        .unwrap();

    assign_wallet
        .execute(AssignWalletToBotInput {
            bot_kind: BotKind::Bidding,
            wallet_id: Some(first_wallet.wallet_id.to_string()),
        })
        .unwrap();
    assign_wallet
        .execute(AssignWalletToBotInput {
            bot_kind: BotKind::Bidding,
            wallet_id: Some(second_wallet.wallet_id.to_string()),
        })
        .unwrap();

    let listed = list_wallets.execute().unwrap();
    let first = listed
        .wallets
        .iter()
        .find(|wallet| wallet.wallet_id == first_wallet.wallet_id)
        .unwrap();
    let second = listed
        .wallets
        .iter()
        .find(|wallet| wallet.wallet_id == second_wallet.wallet_id)
        .unwrap();
    assert!(!first.is_assigned_to_bot(BotKind::Bidding));
    assert!(second.is_assigned_to_bot(BotKind::Bidding));

    assign_wallet
        .execute(AssignWalletToBotInput {
            bot_kind: BotKind::Bidding,
            wallet_id: None,
        })
        .unwrap();

    let listed = list_wallets.execute().unwrap();
    assert!(
        listed
            .wallets
            .iter()
            .all(|wallet| !wallet.is_assigned_to_bot(BotKind::Bidding))
    );
}
