use std::collections::{HashMap, HashSet};

use alloy_primitives::U256;
use serde::{Deserialize, Serialize};

use super::backend_collection_catalog::BiddingCollectionCandidate;
use super::env_keys::{
    BIDDING_DRY_RUN_ENV_KEY, BIDDING_TRAIT_OFFERS_ENABLED_ENV_KEY,
    BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY,
};

/// Maximum collections that one native bidding unlock may authorize.
const MAX_BIDDING_MANDATE_COLLECTIONS: usize = 64;

/// Untrusted Admin input proposed for one bidding bot start.
#[derive(Clone, Debug)]
pub struct BiddingMandateDraft {
    pub collections: Vec<BiddingCollectionMandateDraft>,
}

/// Per-collection limits proposed by the Admin WebView.
#[derive(Clone, Debug)]
pub struct BiddingCollectionMandateDraft {
    pub collection_id: u64,
    pub max_unit_bid_eth: String,
    pub max_quantity: u32,
}

/// Immutable authority granted to one running bidding process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingMandate {
    pub chain_id: u64,
    pub collections: Vec<BiddingCollectionMandate>,
}

/// Canonical ArtGod and OpenSea identity plus limits for one collection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingCollectionMandate {
    pub collection_id: u64,
    pub artgod_slug: String,
    pub contract_address: String,
    pub opensea_slug: String,
    pub token_scope: BiddingCollectionTokenScopeSummary,
    pub max_unit_bid_wei: String,
    pub max_quantity: u32,
}

/// Display-safe token-scope summary resolved from the trusted collection read model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingCollectionTokenScopeSummary {
    pub label: String,
    pub items: Vec<BiddingCollectionTokenScopeItem>,
}

/// One display field in a collection token-scope summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingCollectionTokenScopeItem {
    pub label: String,
    pub value: String,
}

/// Frozen global bidding settings displayed by the native unlock prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BiddingStartPolicySnapshot {
    pub dry_run: bool,
    pub weth_allowance_cap_eth: String,
    pub trait_offers_enabled: bool,
}

impl BiddingMandate {
    /// Resolves untrusted collection ids against canonical live OpenSea-ready collection records.
    pub fn resolve(
        chain_id: u64,
        draft: BiddingMandateDraft,
        candidates: Vec<BiddingCollectionCandidate>,
    ) -> Result<Self, String> {
        if draft.collections.is_empty() {
            return Err("Select at least one collection for the bidding mandate.".to_owned());
        }
        if draft.collections.len() > MAX_BIDDING_MANDATE_COLLECTIONS {
            return Err(format!(
                "A bidding mandate may include at most {MAX_BIDDING_MANDATE_COLLECTIONS} collections."
            ));
        }

        let candidates_by_id = candidates
            .into_iter()
            .map(|candidate| (candidate.collection_id, candidate))
            .collect::<HashMap<_, _>>();
        let mut seen_collection_ids = HashSet::new();
        let mut collections = Vec::with_capacity(draft.collections.len());

        for proposed in draft.collections {
            if !seen_collection_ids.insert(proposed.collection_id) {
                return Err(format!(
                    "Collection {} appears more than once in the bidding mandate.",
                    proposed.collection_id
                ));
            }
            let candidate = candidates_by_id
                .get(&proposed.collection_id)
                .ok_or_else(|| {
                    format!(
                        "Collection {} is not live and OpenSea-ready.",
                        proposed.collection_id
                    )
                })?;
            if candidate.chain_id != chain_id {
                return Err(format!(
                    "Collection {} belongs to chain {}, expected chain {chain_id}.",
                    candidate.collection_id, candidate.chain_id
                ));
            }
            if proposed.max_quantity == 0 {
                return Err(format!(
                    "Collection {} maximum quantity must be greater than zero.",
                    candidate.collection_id
                ));
            }

            collections.push(BiddingCollectionMandate {
                collection_id: candidate.collection_id,
                artgod_slug: candidate.artgod_slug.clone(),
                contract_address: candidate.contract_address.clone(),
                opensea_slug: candidate.opensea_slug.clone(),
                token_scope: candidate.token_scope.clone(),
                max_unit_bid_wei: parse_positive_eth_to_wei(
                    proposed.max_unit_bid_eth.as_str(),
                    candidate.collection_id,
                )?,
                max_quantity: proposed.max_quantity,
            });
        }

        collections.sort_by(|left, right| {
            left.artgod_slug
                .cmp(&right.artgod_slug)
                .then(left.collection_id.cmp(&right.collection_id))
        });

        Ok(Self {
            chain_id,
            collections,
        })
    }
}

impl BiddingStartPolicySnapshot {
    /// Parses prompt-visible policy from the same frozen env passed to the bot process.
    pub fn from_process_env(env: &HashMap<String, String>) -> Result<Self, String> {
        let dry_run = parse_required_bool(env, BIDDING_DRY_RUN_ENV_KEY)?;
        let trait_offers_enabled = parse_required_bool(env, BIDDING_TRAIT_OFFERS_ENABLED_ENV_KEY)?;
        let allowance = env
            .get(BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY)
            .ok_or_else(|| {
                format!("Missing bidding policy setting {BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY}.")
            })?
            .trim();
        let allowance_wei = parse_eth_to_wei(allowance).map_err(|_| {
            format!("Invalid bidding policy setting {BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY}.")
        })?;
        Ok(Self {
            dry_run,
            weth_allowance_cap_eth: format_wei_as_eth(allowance_wei.as_str())?,
            trait_offers_enabled,
        })
    }
}

/// Formats canonical wei for native policy review without floating-point conversion.
pub fn format_wei_as_eth(wei: &str) -> Result<String, String> {
    let parsed = wei
        .parse::<U256>()
        .map_err(|_| "Bidding mandate contains invalid wei.".to_owned())?;
    let padded = format!("{parsed:019}");
    let split_at = padded.len() - 18;
    let whole = padded[..split_at].trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = padded[split_at..].trim_end_matches('0');
    Ok(if fraction.is_empty() {
        whole.to_owned()
    } else {
        format!("{whole}.{fraction}")
    })
}

fn parse_positive_eth_to_wei(raw: &str, collection_id: u64) -> Result<String, String> {
    let normalized_wei = parse_eth_to_wei(raw).map_err(|_| {
        format!(
            "Collection {collection_id} maximum unit bid must be a positive decimal with at most 18 fractional digits."
        )
    })?;
    if normalized_wei == "0" {
        return Err(format!(
            "Collection {collection_id} maximum unit bid must be greater than zero."
        ));
    }
    Ok(normalized_wei)
}

fn parse_eth_to_wei(raw: &str) -> Result<String, ()> {
    let value = raw.trim();
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.is_some_and(|digits| {
            digits.is_empty()
                || digits.len() > 18
                || !digits.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err(());
    }

    let normalized_whole = whole.trim_start_matches('0');
    let normalized_whole = if normalized_whole.is_empty() {
        "0"
    } else {
        normalized_whole
    };
    let mut fractional_wei = fraction.unwrap_or_default().to_owned();
    fractional_wei.extend(std::iter::repeat_n('0', 18 - fractional_wei.len()));
    let combined = format!("{normalized_whole}{fractional_wei}");
    let normalized_wei = combined.trim_start_matches('0');
    let normalized_wei = if normalized_wei.is_empty() {
        "0"
    } else {
        normalized_wei
    };
    normalized_wei.parse::<U256>().map_err(|_| ())?;
    Ok(normalized_wei.to_owned())
}

fn parse_required_bool(env: &HashMap<String, String>, key: &str) -> Result<bool, String> {
    match env.get(key).map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) if value == "true" => Ok(true),
        Some(value) if value == "false" => Ok(false),
        Some(value) => Err(format!("Invalid bidding policy setting {key}: {value}.")),
        None => Err(format!("Missing bidding policy setting {key}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(collection_id: u64) -> BiddingCollectionCandidate {
        BiddingCollectionCandidate {
            chain_id: 1,
            collection_id,
            artgod_slug: format!("collection-{collection_id}"),
            contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
            opensea_slug: format!("opensea-{collection_id}"),
            token_scope: BiddingCollectionTokenScopeSummary {
                label: "all contract tokens".to_owned(),
                items: Vec::new(),
            },
        }
    }

    #[test]
    fn resolves_canonical_identity_and_exact_wei_limits() {
        let mandate = BiddingMandate::resolve(
            1,
            BiddingMandateDraft {
                collections: vec![BiddingCollectionMandateDraft {
                    collection_id: 7,
                    max_unit_bid_eth: "1.25".to_owned(),
                    max_quantity: 3,
                }],
            },
            vec![candidate(7)],
        )
        .unwrap();

        assert_eq!(mandate.collections[0].collection_id, 7);
        assert_eq!(
            mandate.collections[0].max_unit_bid_wei,
            "1250000000000000000"
        );
        assert_eq!(
            format_wei_as_eth(&mandate.collections[0].max_unit_bid_wei).unwrap(),
            "1.25"
        );
    }

    #[test]
    fn rejects_unknown_and_duplicate_collection_ids() {
        let unknown = BiddingMandate::resolve(
            1,
            BiddingMandateDraft {
                collections: vec![BiddingCollectionMandateDraft {
                    collection_id: 8,
                    max_unit_bid_eth: "1".to_owned(),
                    max_quantity: 1,
                }],
            },
            vec![candidate(7)],
        )
        .unwrap_err();
        assert!(unknown.contains("not live and OpenSea-ready"));

        let duplicate = BiddingMandate::resolve(
            1,
            BiddingMandateDraft {
                collections: vec![
                    BiddingCollectionMandateDraft {
                        collection_id: 7,
                        max_unit_bid_eth: "1".to_owned(),
                        max_quantity: 1,
                    },
                    BiddingCollectionMandateDraft {
                        collection_id: 7,
                        max_unit_bid_eth: "2".to_owned(),
                        max_quantity: 2,
                    },
                ],
            },
            vec![candidate(7)],
        )
        .unwrap_err();
        assert!(duplicate.contains("appears more than once"));
    }

    #[test]
    fn rejects_zero_or_overprecision_bid_limits() {
        for value in ["0", "0.0000000000000000001", "1e2", "-1"] {
            let error = parse_positive_eth_to_wei(value, 7).unwrap_err();
            assert!(error.contains("maximum unit bid"));
        }
    }

    #[test]
    fn parses_frozen_start_policy_without_floating_point() {
        let policy = BiddingStartPolicySnapshot::from_process_env(&HashMap::from([
            (BIDDING_DRY_RUN_ENV_KEY.to_owned(), "false".to_owned()),
            (
                BIDDING_TRAIT_OFFERS_ENABLED_ENV_KEY.to_owned(),
                "true".to_owned(),
            ),
            (
                BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY.to_owned(),
                "1.2500".to_owned(),
            ),
        ]))
        .unwrap();

        assert!(!policy.dry_run);
        assert!(policy.trait_offers_enabled);
        assert_eq!(policy.weth_allowance_cap_eth, "1.25");
    }
}
