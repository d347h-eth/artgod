use std::collections::HashSet;

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};

use super::bidding_mandate::BiddingCollectionTokenScopeSummary;
use super::http_fetch_resilience::{HttpFetchClient, HttpFetchError, HttpFetchResilienceConfig};

const COLLECTION_STATUS_QUERY_PARAM: &str = "status";
const COLLECTION_CURSOR_QUERY_PARAM: &str = "cursor";
const COLLECTION_STATUS_LIVE: &str = "live";

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
    chain: CollectionChain,
    page: ListCollectionsPage,
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
