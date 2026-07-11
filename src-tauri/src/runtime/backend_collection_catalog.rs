use std::collections::HashSet;

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};

use super::bidding_mandate::BiddingCollectionTokenScopeSummary;

const COLLECTION_STATUS_QUERY_PARAM: &str = "status";
const COLLECTION_CURSOR_QUERY_PARAM: &str = "cursor";
const COLLECTION_STATUS_LIVE: &str = "live";

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
    client: reqwest::Client,
    backend_http_base_url: String,
}

impl BackendCollectionCatalog {
    /// Creates a catalog adapter for the supervisor-owned backend endpoint.
    pub fn new(backend_http_base_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            backend_http_base_url: backend_http_base_url.into(),
        }
    }

    /// Streams every live page and returns collections whose OpenSea identity is ready.
    pub async fn list_bidding_candidates(
        &self,
        chain_id: u64,
    ) -> Result<Vec<BiddingCollectionCandidate>, String> {
        let endpoint = format!(
            "{}/api/{chain_id}/collections",
            self.backend_http_base_url.trim_end_matches('/')
        );
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        let mut candidates = Vec::new();

        loop {
            let mut request = self
                .client
                .get(endpoint.as_str())
                .query(&[(COLLECTION_STATUS_QUERY_PARAM, COLLECTION_STATUS_LIVE)]);
            if let Some(value) = cursor.as_deref() {
                request = request.query(&[(COLLECTION_CURSOR_QUERY_PARAM, value)]);
            }

            // Resolve collection identity from the same read model used by Userland.
            let response = request
                .send()
                .await
                .map_err(|_| "Start infra to use Bots.".to_owned())?
                .error_for_status()
                .map_err(|error| format!("Collection catalog request was rejected: {error}"))?
                .json::<ListCollectionsResponse>()
                .await
                .map_err(|error| format!("Collection catalog response was invalid: {error}"))?;

            for item in response.page.items {
                if let Some(candidate) = map_bidding_candidate(item, chain_id)? {
                    candidates.push(candidate);
                }
            }

            let Some(next_cursor) = response.page.next_cursor else {
                break;
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return Err("Collection catalog returned a repeated cursor.".to_owned());
            }
            cursor = Some(next_cursor);
        }

        candidates.sort_by(|left, right| {
            left.artgod_slug
                .cmp(&right.artgod_slug)
                .then(left.collection_id.cmp(&right.collection_id))
        });
        Ok(candidates)
    }
}

fn map_bidding_candidate(
    item: CollectionItem,
    expected_chain_id: u64,
) -> Result<Option<BiddingCollectionCandidate>, String> {
    if item.chain_id != expected_chain_id
        || item.opensea_status != Some(OpenSeaCollectionStatus::Ready)
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
    page: ListCollectionsPage,
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
    opensea_status: Option<OpenSeaCollectionStatus>,
    token_scope: Option<BiddingCollectionTokenScopeSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OpenSeaCollectionStatus {
    Pending,
    IdentityRunning,
    Subscribing,
    SnapshotPending,
    SnapshotRunning,
    Ready,
    Retrying,
    Failed,
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
    use super::*;

    #[test]
    fn maps_only_ready_collection_identity_into_canonical_candidate() {
        let candidate = map_bidding_candidate(collection_item(), 1)
            .expect("candidate should map")
            .expect("ready collection should be eligible");

        assert_eq!(candidate.collection_id, 7);
        assert_eq!(
            candidate.contract_address,
            "0x1111111111111111111111111111111111111111"
        );
        assert_eq!(candidate.opensea_slug, "shared-contract-opensea");
        assert_eq!(candidate.token_scope.label, "token range");
    }

    #[test]
    fn ignores_collection_without_ready_opensea_identity() {
        let mut item = collection_item();
        item.opensea_status = Some(OpenSeaCollectionStatus::Pending);

        assert!(map_bidding_candidate(item, 1).unwrap().is_none());
    }

    fn collection_item() -> CollectionItem {
        CollectionItem {
            chain_id: 1,
            collection_id: 7,
            slug: "shared-contract-art".to_owned(),
            address: "0x1111111111111111111111111111111111111111".to_owned(),
            opensea_slug: Some("Shared-Contract-OpenSea".to_owned()),
            opensea_status: Some(OpenSeaCollectionStatus::Ready),
            token_scope: Some(BiddingCollectionTokenScopeSummary {
                label: "token range".to_owned(),
                items: Vec::new(),
            }),
        }
    }
}
