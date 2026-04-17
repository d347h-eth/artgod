use serde::Serialize;

use crate::wallet::domain::{BotKind, WalletId, WalletPrivateKey};

const SECRET_ENVELOPE_MAGIC: &[u8; 8] = b"AGBOTKEY";
const SECRET_ENVELOPE_VERSION: u8 = 1;
const SECRET_KEY_LENGTH_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BotRuntimeState {
    Disabled,
    Locked,
    AwaitingUnlock,
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCriticalDependencyStatus {
    pub process: String,
    pub healthy: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeSnapshot {
    pub bot_kind: BotKind,
    pub process_name: String,
    pub state: BotRuntimeState,
    pub last_error: Option<String>,
    pub critical_dependencies: Vec<BotCriticalDependencyStatus>,
}

#[derive(Clone, Copy, Debug)]
pub struct BotRuntimeSpec {
    pub bot_kind: BotKind,
    pub process_name: &'static str,
    pub artifact_relative_path: &'static str,
    pub startup_reason: &'static str,
    pub critical_processes: &'static [&'static str],
}

pub const BIDDING_BOT_SPEC: BotRuntimeSpec = BotRuntimeSpec {
    bot_kind: BotKind::Bidding,
    process_name: "trading-bidding-bot",
    artifact_relative_path: "trading/dist-desktop/bidding-bot-runtime.mjs",
    startup_reason: "start bidding bot",
    critical_processes: &[
        "nats",
        "backend",
        "indexer-sync-worker",
        "indexer-reorg-worker",
        "indexer-domain-worker",
    ],
};

pub const SNIPING_BOT_SPEC: BotRuntimeSpec = BotRuntimeSpec {
    bot_kind: BotKind::Sniping,
    process_name: "trading-sniping-bot",
    artifact_relative_path: "trading/dist-desktop/sniping-bot-runtime.mjs",
    startup_reason: "start sniping bot",
    critical_processes: &[
        "nats",
        "backend",
        "indexer-sync-worker",
        "indexer-reorg-worker",
        "indexer-domain-worker",
        "indexer-opensea-stream-worker",
    ],
};

pub const BOT_RUNTIME_SPECS: &[BotRuntimeSpec] = &[BIDDING_BOT_SPEC, SNIPING_BOT_SPEC];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TradingSecretEnvelopeMetadata {
    wallet_id: String,
    address: String,
    bot_kind: BotKind,
    chain_id: u64,
}

pub fn bot_runtime_spec(bot_kind: BotKind) -> &'static BotRuntimeSpec {
    match bot_kind {
        BotKind::Bidding => &BIDDING_BOT_SPEC,
        BotKind::Sniping => &SNIPING_BOT_SPEC,
    }
}

pub fn build_trading_secret_envelope(
    wallet_id: &WalletId,
    address: &str,
    bot_kind: BotKind,
    chain_id: u64,
    private_key: &WalletPrivateKey,
) -> Result<Vec<u8>, String> {
    let metadata = TradingSecretEnvelopeMetadata {
        wallet_id: wallet_id.to_string(),
        address: address.to_owned(),
        bot_kind,
        chain_id,
    };
    let metadata_json = serde_json::to_vec(&metadata)
        .map_err(|error| format!("metadata serialize failed: {error}"))?;
    let mut payload = Vec::with_capacity(
        SECRET_ENVELOPE_MAGIC.len() + 1 + 4 + metadata_json.len() + SECRET_KEY_LENGTH_BYTES,
    );
    payload.extend_from_slice(SECRET_ENVELOPE_MAGIC);
    payload.push(SECRET_ENVELOPE_VERSION);
    payload.extend_from_slice(&(metadata_json.len() as u32).to_be_bytes());
    payload.extend_from_slice(&metadata_json);
    payload.extend_from_slice(private_key.as_bytes());
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn trading_secret_envelope_binary_layout_is_stable() {
        let wallet_id = WalletId::parse("11111111-1111-4111-8111-111111111111").unwrap();
        let private_key = WalletPrivateKey::new([7_u8; 32]);
        let payload = build_trading_secret_envelope(
            &wallet_id,
            "0x1111111111111111111111111111111111111111",
            BotKind::Bidding,
            1,
            &private_key,
        )
        .unwrap();

        assert_eq!(&payload[..8], SECRET_ENVELOPE_MAGIC);
        assert_eq!(payload[8], SECRET_ENVELOPE_VERSION);
        let metadata_length =
            u32::from_be_bytes(payload[9..13].try_into().expect("metadata length bytes"));
        let metadata_end = 13 + metadata_length as usize;
        let metadata: Value = serde_json::from_slice(&payload[13..metadata_end]).unwrap();
        assert_eq!(metadata["walletId"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(metadata["botKind"], "bidding");
        assert_eq!(payload.len() - metadata_end, SECRET_KEY_LENGTH_BYTES);
    }
}
