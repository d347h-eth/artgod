use std::collections::{HashMap, HashSet};

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};

use super::bidding_mandate::{BiddingCollectionTokenScopeSummary, normalize_positive_eth};
use super::http_fetch_resilience::{HttpFetchClient, HttpFetchError, HttpFetchResilienceConfig};

const COLLECTION_STATUS_QUERY_PARAM: &str = "status";
const COLLECTION_CURSOR_QUERY_PARAM: &str = "cursor";
const COLLECTION_STATUS_LIVE: &str = "live";
const BIDDING_JOB_CEILING_PREFILLS_ROUTE_SUFFIX: &str = "bidding/jobs/ceiling-prefills";

/// Canonical display identity for the chain that owns the bidding catalog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingChainIdentity {
    pub chain_id: u64,
    pub name: String,
}

/// Canonical chain context and collections eligible for bidding authorization.
#[derive(Clone, Debug)]
pub struct BiddingCollectionCatalog {
    pub chain: BiddingChainIdentity,
    pub collections: Vec<BiddingCollectionCandidate>,
}

/// Canonical collection identity eligible for native bidding authorization.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiddingCollectionCandidate {
    pub chain_id: u64,
    pub collection_id: u64,
    pub artgod_slug: String,
    pub contract_address: String,
    pub opensea_slug: String,
    pub token_scope: BiddingCollectionTokenScopeSummary,
}

/// Reads non-secret collection identity through the backend's canonical read model.
pub struct BackendCollectionCatalog {
    client: HttpFetchClient,
    backend_http_base_url: String,
}

/// Separates concise operator recovery from durable catalog diagnostics.
#[derive(Debug)]
pub(crate) struct BackendCollectionCatalogError {
    user_message: String,
    detail: String,
}

impl BackendCollectionCatalogError {
    /// Returns the concise recovery shown in Admin.
    pub(crate) fn user_message(&self) -> &str {
        &self.user_message
    }

    /// Returns the technical failure written to the durable desktop log.
    pub(crate) fn detail(&self) -> &str {
        &self.detail
    }

    fn client(detail: String) -> Self {
        Self {
            user_message: "Collection catalog could not start. Restart ArtGod.".to_owned(),
            detail,
        }
    }

    fn invalid_prefill(detail: String) -> Self {
        Self {
            user_message: "Bidding limit prefills were invalid. See desktop-app logs.".to_owned(),
            detail,
        }
    }
}

impl From<String> for BackendCollectionCatalogError {
    fn from(detail: String) -> Self {
        Self {
            user_message: "Collection catalog response was invalid. See desktop-app logs."
                .to_owned(),
            detail,
        }
    }
}

impl BackendCollectionCatalog {
    /// Creates a catalog adapter for the supervisor-owned backend endpoint.
    pub(crate) fn new(
        backend_http_base_url: impl Into<String>,
        resilience: &HttpFetchResilienceConfig,
    ) -> Result<Self, BackendCollectionCatalogError> {
        Ok(Self {
            client: HttpFetchClient::new(resilience)
                .map_err(BackendCollectionCatalogError::client)?,
            backend_http_base_url: backend_http_base_url.into(),
        })
    }

    /// Streams every live page with its chain context and OpenSea-ready collections.
    pub async fn load_bidding_catalog(
        &self,
        chain_id: u64,
    ) -> Result<BiddingCollectionCatalog, BackendCollectionCatalogError> {
        let endpoint = format!(
            "{}/api/{chain_id}/collections",
            self.backend_http_base_url.trim_end_matches('/')
        );
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        let mut chain = None;
        let mut candidates = Vec::new();

        loop {
            let mut query = vec![(COLLECTION_STATUS_QUERY_PARAM, COLLECTION_STATUS_LIVE)];
            if let Some(value) = cursor.as_deref() {
                query.push((COLLECTION_CURSOR_QUERY_PARAM, value));
            }

            // Resolve collection identity from the same read model used by Userland.
            let response = self
                .client
                .get_json::<ListCollectionsResponse, _>(endpoint.as_str(), &query)
                .await
                .map_err(map_catalog_fetch_error)?;

            let response_chain = map_chain_identity(response.chain, chain_id)?;
            if chain
                .as_ref()
                .is_some_and(|expected| expected != &response_chain)
            {
                return Err("Collection catalog changed chain identity between pages."
                    .to_owned()
                    .into());
            }
            chain.get_or_insert(response_chain);

            for item in response.page.items {
                if let Some(candidate) = map_bidding_candidate(item, chain_id)? {
                    candidates.push(candidate);
                }
            }

            let Some(next_cursor) = response.page.next_cursor else {
                break;
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return Err("Collection catalog returned a repeated cursor."
                    .to_owned()
                    .into());
            }
            cursor = Some(next_cursor);
        }

        candidates.sort_by(|left, right| {
            left.artgod_slug
                .cmp(&right.artgod_slug)
                .then(left.collection_id.cmp(&right.collection_id))
        });
        Ok(BiddingCollectionCatalog {
            chain: chain.ok_or_else(|| "Collection catalog omitted chain identity.".to_owned())?,
            collections: candidates,
        })
    }

    /// Loads one editable Admin price prefill for each collection with enabled or paused jobs.
    pub async fn load_job_ceiling_prefill_eth_by_collection(
        &self,
        chain_id: u64,
    ) -> Result<HashMap<u64, String>, BackendCollectionCatalogError> {
        let endpoint = format!(
            "{}/api/{chain_id}/{BIDDING_JOB_CEILING_PREFILLS_ROUTE_SUFFIX}",
            self.backend_http_base_url.trim_end_matches('/')
        );
        let query: [(&str, &str); 0] = [];

        // Fetch every enabled-or-paused ceiling maximum through one backend batch read.
        let response = self
            .client
            .get_json::<ListBiddingJobCeilingPrefillsResponse, _>(endpoint.as_str(), &query)
            .await
            .map_err(map_ceiling_prefill_fetch_error)?;
        map_job_ceiling_prefill_response(response, chain_id)
            .map_err(BackendCollectionCatalogError::invalid_prefill)
    }
}

fn map_job_ceiling_prefill_response(
    response: ListBiddingJobCeilingPrefillsResponse,
    expected_chain_id: u64,
) -> Result<HashMap<u64, String>, String> {
    map_chain_identity(response.chain, expected_chain_id)?;
    let mut prefills = HashMap::with_capacity(response.prefills.len());
    for prefill in response.prefills {
        if prefill.collection_id == 0 {
            return Err("Bidding job ceiling prefills returned collection ID zero.".to_owned());
        }
        let max_ceiling_eth =
            normalize_positive_eth(prefill.max_ceiling_eth.as_str()).map_err(|_| {
                format!(
                    "Collection {} returned an invalid bidding job ceiling prefill.",
                    prefill.collection_id
                )
            })?;
        if prefills
            .insert(prefill.collection_id, max_ceiling_eth)
            .is_some()
        {
            return Err(format!(
                "Collection {} appeared more than once in bidding job ceiling prefills.",
                prefill.collection_id
            ));
        }
    }
    Ok(prefills)
}

fn map_catalog_fetch_error(error: HttpFetchError) -> BackendCollectionCatalogError {
    match error {
        HttpFetchError::Transport(error) => {
            let user_message = if error.is_connect() {
                "Start infra to use Bots."
            } else if error.is_timeout() {
                "Collection catalog did not respond. Restart infra and refresh Bots."
            } else {
                "Collection catalog request failed. Restart infra and refresh Bots."
            };
            BackendCollectionCatalogError {
                user_message: user_message.to_owned(),
                detail: format!("Collection catalog transport failed: {error}"),
            }
        }
        HttpFetchError::Status(error) => BackendCollectionCatalogError {
            user_message:
                "Collection catalog request was rejected. Restart infra and refresh Bots."
                    .to_owned(),
            detail: format!("Collection catalog request was rejected: {error}"),
        },
        HttpFetchError::Decode(error) => BackendCollectionCatalogError {
            user_message: "Collection catalog response was invalid. See desktop-app logs."
                .to_owned(),
            detail: format!("Collection catalog response was invalid: {error}"),
        },
        HttpFetchError::RetryDelay(error) => BackendCollectionCatalogError {
            user_message: "Collection catalog request failed. See desktop-app logs.".to_owned(),
            detail: error,
        },
    }
}

fn map_ceiling_prefill_fetch_error(error: HttpFetchError) -> BackendCollectionCatalogError {
    match error {
        HttpFetchError::Transport(error) => {
            let user_message = if error.is_connect() {
                "Start infra to use Bots."
            } else if error.is_timeout() {
                "Bidding limit prefills did not respond. Restart infra and refresh Bots."
            } else {
                "Bidding limit prefills failed. Restart infra and refresh Bots."
            };
            BackendCollectionCatalogError {
                user_message: user_message.to_owned(),
                detail: format!("Bidding job ceiling prefills transport failed: {error}"),
            }
        }
        HttpFetchError::Status(error) => BackendCollectionCatalogError {
            user_message: "Bidding limit prefills were rejected. Restart infra and refresh Bots."
                .to_owned(),
            detail: format!("Bidding job ceiling prefills request was rejected: {error}"),
        },
        HttpFetchError::Decode(error) => BackendCollectionCatalogError {
            user_message: "Bidding limit prefills were invalid. See desktop-app logs.".to_owned(),
            detail: format!("Bidding job ceiling prefills response was invalid: {error}"),
        },
        HttpFetchError::RetryDelay(error) => BackendCollectionCatalogError {
            user_message: "Bidding limit prefills failed. See desktop-app logs.".to_owned(),
            detail: error,
        },
    }
}

fn map_chain_identity(
    chain: CollectionChain,
    expected_chain_id: u64,
) -> Result<BiddingChainIdentity, String> {
    if chain.public_chain_id != expected_chain_id {
        return Err(format!(
            "Collection catalog returned chain ID {}, expected {expected_chain_id}.",
            chain.public_chain_id
        ));
    }
    let name = chain.name.trim().to_owned();
    if name.is_empty() {
        return Err("Collection catalog returned an empty chain name.".to_owned());
    }
    Ok(BiddingChainIdentity {
        chain_id: chain.public_chain_id,
        name,
    })
}

fn map_bidding_candidate(
    item: CollectionItem,
    expected_chain_id: u64,
) -> Result<Option<BiddingCollectionCandidate>, String> {
    if item.chain_id != expected_chain_id
        || !has_completed_opensea_readiness(item.opensea_ready_at.as_deref())
    {
        return Ok(None);
    }
    let Some(opensea_slug) = normalize_slug(item.opensea_slug) else {
        return Ok(None);
    };
    let contract_address = item
        .address
        .trim()
        .parse::<Address>()
        .map_err(|_| {
            format!(
                "Collection {} has an invalid contract address.",
                item.collection_id
            )
        })?
        .to_string();
    let token_scope = item.token_scope.ok_or_else(|| {
        format!(
            "Collection {} is missing its token-scope summary.",
            item.collection_id
        )
    })?;
    Ok(Some(BiddingCollectionCandidate {
        chain_id: item.chain_id,
        collection_id: item.collection_id,
        artgod_slug: normalize_artgod_slug(item.slug, item.collection_id)?,
        contract_address,
        opensea_slug,
        token_scope,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCollectionsResponse {
    chain: CollectionChain,
    page: ListCollectionsPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListBiddingJobCeilingPrefillsResponse {
    chain: CollectionChain,
    prefills: Vec<BiddingJobCeilingPrefill>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BiddingJobCeilingPrefill {
    collection_id: u64,
    max_ceiling_eth: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionChain {
    public_chain_id: u64,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCollectionsPage {
    items: Vec<CollectionItem>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionItem {
    chain_id: u64,
    collection_id: u64,
    slug: String,
    address: String,
    opensea_slug: Option<String>,
    opensea_ready_at: Option<String>,
    token_scope: Option<BiddingCollectionTokenScopeSummary>,
}

fn has_completed_opensea_readiness(ready_at: Option<&str>) -> bool {
    ready_at.is_some_and(|value| !value.trim().is_empty())
}

fn normalize_slug(value: Option<String>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_artgod_slug(value: String, collection_id: u64) -> Result<String, String> {
    let normalized = value.trim().to_owned();
    if normalized.is_empty() {
        return Err(format!(
            "Collection {collection_id} has an empty ArtGod slug."
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_completed_opensea_identity_into_canonical_candidate() {
        let candidate = map_bidding_candidate(collection_item(), 1)
            .expect("candidate should map")
            .expect("previously ready collection should be eligible");

        assert_eq!(candidate.collection_id, 7);
        assert_eq!(
            candidate.contract_address,
            "0x1111111111111111111111111111111111111111"
        );
        assert_eq!(candidate.opensea_slug, "shared-contract-opensea");
        assert_eq!(candidate.token_scope.label, "token range");
    }

    #[test]
    fn maps_previously_ready_collection_while_current_reconcile_retries() {
        let item = serde_json::from_value::<CollectionItem>(json!({
            "chainId": 1,
            "collectionId": 7,
            "slug": "shared-contract-art",
            "address": "0x1111111111111111111111111111111111111111",
            "openseaSlug": "Shared-Contract-OpenSea",
            "openseaStatus": "retrying",
            "openseaReadyAt": "2026-07-12 00:57:00",
            "tokenScope": {
                "label": "token range",
                "items": []
            }
        }))
        .expect("collection response should deserialize");

        assert!(map_bidding_candidate(item, 1).unwrap().is_some());
    }

    #[test]
    fn ignores_collection_without_completed_opensea_readiness() {
        let mut item = collection_item();
        item.opensea_ready_at = None;

        assert!(map_bidding_candidate(item, 1).unwrap().is_none());

        let mut blank = collection_item();
        blank.opensea_ready_at = Some("   ".to_owned());

        assert!(map_bidding_candidate(blank, 1).unwrap().is_none());
    }

    #[test]
    fn maps_named_chain_identity_for_operator_display() {
        let chain = map_chain_identity(
            CollectionChain {
                public_chain_id: 1,
                name: " Ethereum ".to_owned(),
            },
            1,
        )
        .expect("chain identity should map");

        assert_eq!(chain.chain_id, 1);
        assert_eq!(chain.name, "Ethereum");
    }

    #[test]
    fn invalid_catalog_detail_stays_out_of_the_operator_message() {
        let error = BackendCollectionCatalogError::from(
            "raw catalog detail with http://127.0.0.1:42710".to_owned(),
        );

        assert_eq!(
            error.user_message(),
            "Collection catalog response was invalid. See desktop-app logs."
        );
        assert!(error.detail().contains("http://127.0.0.1:42710"));
    }

    #[test]
    fn maps_canonical_job_ceiling_prefills_and_rejects_duplicates() {
        let response = ListBiddingJobCeilingPrefillsResponse {
            chain: CollectionChain {
                public_chain_id: 1,
                name: "Ethereum".to_owned(),
            },
            prefills: vec![BiddingJobCeilingPrefill {
                collection_id: 7,
                max_ceiling_eth: "01.2500".to_owned(),
            }],
        };

        assert_eq!(
            map_job_ceiling_prefill_response(response, 1)
                .unwrap()
                .get(&7)
                .map(String::as_str),
            Some("1.25")
        );

        let duplicate = ListBiddingJobCeilingPrefillsResponse {
            chain: CollectionChain {
                public_chain_id: 1,
                name: "Ethereum".to_owned(),
            },
            prefills: vec![
                BiddingJobCeilingPrefill {
                    collection_id: 7,
                    max_ceiling_eth: "1".to_owned(),
                },
                BiddingJobCeilingPrefill {
                    collection_id: 7,
                    max_ceiling_eth: "2".to_owned(),
                },
            ],
        };
        assert!(map_job_ceiling_prefill_response(duplicate, 1).is_err());
    }

    fn collection_item() -> CollectionItem {
        CollectionItem {
            chain_id: 1,
            collection_id: 7,
            slug: "shared-contract-art".to_owned(),
            address: "0x1111111111111111111111111111111111111111".to_owned(),
            opensea_slug: Some("Shared-Contract-OpenSea".to_owned()),
            opensea_ready_at: Some("2026-07-12 00:57:00".to_owned()),
            token_scope: Some(BiddingCollectionTokenScopeSummary {
                label: "token range".to_owned(),
                items: Vec::new(),
            }),
        }
    }
}
