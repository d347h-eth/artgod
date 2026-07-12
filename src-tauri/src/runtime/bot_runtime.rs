use serde::Serialize;

use super::bidding_mandate::BiddingMandate;
use crate::wallet::domain::{BotKind, WalletId, WalletPrivateKey};

const SECRET_ENVELOPE_MAGIC: &[u8; 8] = b"AGBOTKEY";
const SECRET_ENVELOPE_VERSION: u8 = 2;
const SECRET_KEY_LENGTH_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BotRuntimeState {
    Disabled,
    Locked,
    AwaitingUnlock,
    Starting,
    Bootstrapping,
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
    pub bidding_mandate: Option<BiddingMandate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    critical_processes: &[],
};

pub const SNIPING_BOT_SPEC: BotRuntimeSpec = BotRuntimeSpec {
    bot_kind: BotKind::Sniping,
    process_name: "trading-sniping-bot",
    artifact_relative_path: "trading/dist-desktop/sniping-bot-runtime.mjs",
    startup_reason: "start sniping bot",
    critical_processes: &[],
};

pub const BOT_RUNTIME_SPECS: &[BotRuntimeSpec] = &[BIDDING_BOT_SPEC, SNIPING_BOT_SPEC];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TradingSecretEnvelopeMetadata<'a> {
    wallet_id: String,
    address: String,
    bot_kind: BotKind,
    chain_id: u64,
    bidding_mandate: Option<&'a BiddingMandate>,
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
    bidding_mandate: Option<&BiddingMandate>,
    private_key: &WalletPrivateKey,
) -> Result<Vec<u8>, String> {
    match (bot_kind, bidding_mandate) {
        (BotKind::Bidding, None) => {
            return Err("Bidding bot secret envelope requires a native mandate.".to_owned());
        }
        (BotKind::Sniping, Some(_)) => {
            return Err("Sniping bot secret envelope cannot carry a bidding mandate.".to_owned());
        }
        _ => {}
    }
    let metadata = TradingSecretEnvelopeMetadata {
        wallet_id: wallet_id.to_string(),
        address: address.to_owned(),
        bot_kind,
        chain_id,
        bidding_mandate,
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
    use std::fs;
    use std::path::Path;

    use alloy_primitives::hex;
    use serde::Deserialize;
    use serde_json::Value;

    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TradingSecretEnvelopeFixture {
        wallet_id: String,
        address: String,
        bot_kind: String,
        chain_id: u64,
        bidding_mandate: BiddingMandate,
        private_key_hex: String,
        payload_hex: String,
    }

    fn load_fixture() -> TradingSecretEnvelopeFixture {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../trading/src/runtime/fixtures/secret-envelope-v2.json");
        let raw = fs::read_to_string(&fixture_path).expect("fixture file should load");
        serde_json::from_str(&raw).expect("fixture json should parse")
    }

    #[test]
    fn trading_secret_envelope_binary_layout_is_stable() {
        let wallet_id = WalletId::parse("11111111-1111-4111-8111-111111111111").unwrap();
        let private_key = WalletPrivateKey::new([7_u8; 32]);
        let payload = build_trading_secret_envelope(
            &wallet_id,
            "0x1111111111111111111111111111111111111111",
            BotKind::Bidding,
            1,
            Some(&test_bidding_mandate()),
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

    #[test]
    fn trading_secret_envelope_matches_shared_fixture() {
        let fixture = load_fixture();
        let wallet_id = WalletId::parse(fixture.wallet_id.as_str()).unwrap();
        let private_key_bytes = hex::decode(fixture.private_key_hex).unwrap();
        let private_key = WalletPrivateKey::new(private_key_bytes.try_into().unwrap());
        let bot_kind = match fixture.bot_kind.as_str() {
            "bidding" => BotKind::Bidding,
            "sniping" => BotKind::Sniping,
            other => panic!("unexpected bot kind fixture value: {other}"),
        };

        let payload = build_trading_secret_envelope(
            &wallet_id,
            fixture.address.as_str(),
            bot_kind,
            fixture.chain_id,
            Some(&fixture.bidding_mandate),
            &private_key,
        )
        .unwrap();

        assert_eq!(hex::encode(payload), fixture.payload_hex);
    }

    fn test_bidding_mandate() -> BiddingMandate {
        use super::super::bidding_mandate::{
            BIDDING_MANDATE_MAX_OFFER_QUANTITY, BiddingCollectionMandate,
            BiddingCollectionTokenScopeSummary,
        };

        BiddingMandate {
            chain_id: 1,
            collections: vec![BiddingCollectionMandate {
                collection_id: 7,
                artgod_slug: "example".to_owned(),
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                opensea_slug: "example-opensea".to_owned(),
                token_scope: BiddingCollectionTokenScopeSummary {
                    label: "all contract tokens".to_owned(),
                    items: Vec::new(),
                },
                max_unit_bid_wei: "1250000000000000000".to_owned(),
                max_quantity: BIDDING_MANDATE_MAX_OFFER_QUANTITY,
            }],
        }
    }
}
