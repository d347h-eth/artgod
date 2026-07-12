# Metadata Domain

The metadata domain resolves token URIs and fetches token metadata for assets observed in transfer events.

Primary files:

- `indexer/src/infra/domain/metadata.ts`
- `indexer/src/infra/metadata/viem-token-uri.ts`
- `indexer/src/infra/metadata/http-fetcher.ts`

Schema:

- `database/migrations/004_metadata_schema.sql`

## Inputs

The metadata domain consumes `domain.metadata.sync` jobs with a block range plus an explicit projection contract.

Current behavior:

- `projection = current_state`
    - scans `nft_transfer_events` to discover tokens in the requested range
    - only considers transfer rows whose block is strictly after the owning collection's `bootstrap_anchor_block`
- `projection = facts_only`
    - no-op for canonical metadata writes

This keeps historical backfill before the bootstrap anchor from rewriting current metadata/materialized token state.

## Metadata Refresh Jobs

Metadata refreshes are handled out-of-band via `domain.metadata.refresh` jobs. These jobs are produced by:

- **On-chain triggers**: the sync pipeline decodes ERC‑4906 `MetadataUpdate` / `BatchMetadataUpdate` logs via the trigger registry in `indexer/src/application/metadata/refresh-triggers.ts`.
- `MetadataUpdate` publishes token-level refresh jobs.
- `BatchMetadataUpdate` publishes collection-scoped range refresh jobs (`domain.metadata.refresh-range`) with a queue cursor.
- The domain worker processes range jobs in chunks (`METADATA_REFRESH_RANGE_CHUNK_SIZE`) and re-enqueues the next cursor until complete.
- **Offchain triggers**: the OpenSea stream `item_metadata_updated` event is normalized into a refresh job with a known `collectionId + tokenId`.

The refresh job payload carries a reason/source string so the metadata domain can log what triggered the refresh. `collectionId` is the authoritative job anchor; contract address is derived from the collection row only when the metadata domain needs onchain reads such as `tokenURI(...)`.

Collection extensions already participate in this path in v1, but through sync-worker enrichment rather than through the core ERC-4906 trigger registry:

- sync-worker resolves enabled extension watch specs for the tracked collections
- extension-specific logs are normalized into the same collection-scoped metadata refresh job shapes
- domain-worker consumes those jobs exactly like any other metadata refresh trigger

## Trait Stats Recompute

Trait counts are recomputed into `collection_trait_stats` through `domain.metadata.stats-recompute` jobs on the dedicated `metadata-stats` queue.

- Metadata sync enqueues recompute per touched collection.
- Metadata refresh (single and range/cursor mode) enqueues recompute on successful token updates.
- Bootstrap metadata snapshot completion enqueues recompute with reason `bootstrap-metadata-snapshot`.
- Bootstrap finalization or extension-artifact terminality enqueues recompute with reason `bootstrap-finalized`.
- Reorg backfill metadata sync is classified as `reorg-resync` for stats recompute jobs.
- Recompute strategy is replace-in-transaction for deterministic correctness:
    - delete existing stats rows for the collection.
    - insert fresh counts from normalized `token_attributes` + `attributes`.

## Token Discovery

For each block range:

- Query `nft_transfer_events` grouped by `(collection_id, token_id, kind)`.
- For each token, skip if metadata already exists in `token_metadata`.
- Ignore rows that are not anchor-eligible current-state events for the target collection(s).

## URI Resolution

`ViemTokenUriResolver` reads on-chain metadata:

- ERC721: calls `tokenURI(tokenId)`.
- ERC1155: calls `uri(tokenId)` and expands `{id}` placeholders to 64-char hex.

Metrics are recorded for latency and failures.

## Metadata Fetching

`HttpMetadataFetcher` fetches JSON metadata from a resolved URI:

- Supports `http://`, `https://`, and `ipfs://` (via gateway).
- Supports `data:application/json` URIs.
- Normalizes IPFS references through `COMMON_IPFS_GATEWAY_ORIGIN`.
- Enforces a configurable timeout (default 10s).
- Retries ordinary HTTP fetch failures with bounded exponential backoff via
  `COMMON_HTTP_FETCH_RETRY_*`.
- Normalizes attribute structures to a standard shape.

Results are stored in `token_metadata`, and normalized traits are stored in `token_attributes`.
Large debug-only metadata fields are controlled separately:

- with `PERSIST_RAW_DEBUG_PAYLOADS=false` (default), canonical metadata still writes token identity, name/description/media fields, attribution, and normalized `token_attributes`, but omits raw URI, raw JSON, and attributes JSON retention; `token_metadata.uri` stays `NULL` rather than a placeholder value
- with `PERSIST_RAW_DEBUG_PAYLOADS=true`, `token_metadata.uri`, `token_metadata.raw_json`, and `token_metadata.attributes_json` retain the fetched source payload data for source-normalization debugging

Bootstrap token-image caching is intentionally downstream from this metadata write:

- the cache reads canonical `token_metadata.image`
- bootstrap runs may override which source metadata field is normalized into
  canonical `token_metadata.image` through `request_image_source_field`
- bootstrap runs may override which source metadata field is normalized into
  canonical `token_metadata.animation_url` through `request_animation_source_field`
- a null `request_animation_source_field` disables animation capture for that
  bootstrap run
- it does not cache `animation_url`
- cache output affects read-model presentation through `/media/token-images/...`, without mutating canonical metadata
- when no cached image is available, backend read models resolve IPFS image and
  animation references through `COMMON_IPFS_GATEWAY_ORIGIN` for browser
  presentation while preserving raw canonical metadata

## Canonical Metadata First, Extension Artifacts Second

Collection extensions do **not** replace the canonical metadata domain.

Current behavior:

1. canonical metadata resolution/fetch/normalization completes first
2. `token_metadata` and metadata-sourced normalized attribute rows are committed
3. bootstrap-worker publishes an early canonical metadata stats checkpoint when the bootstrap metadata snapshot completes
4. bootstrap-worker or domain-worker publishes `collection-extension.refresh-artifacts` as a side-effect if the collection has an enabled install
5. bootstrap-worker can also seed extension-owned artifact tasks that do not come from canonical metadata rows, in the same transaction as metadata-derived extension tasks
6. collection-extension-worker performs extension-specific artifact refresh
7. collection-extension-worker replaces any extension-owned normalized traits and writes `token_extension_artifacts`

This split is intentional:

- canonical metadata stays authoritative for token identity and normalized traits
- extension-owned traits are first-class normalized traits, but do not mutate `token_metadata.attributes_json`
- extension-owned synthetic rows can participate in token browsing without creating canonical `token_metadata`
- extension logic can fail/retry independently
- bootstrap readiness and canonical metadata refreshes do not wait on extension artifact completion

## Terraforms-Specific Metadata Behavior

The first embedded extension, `terraforms`, shadows the metadata path in a very specific way:

- it always targets the Terraforms version-2 renderer artifacts, regardless of the token owner-selected renderer version
- for minted canonical tokens, it reads the normalized `Mode` attribute from SQLite joins over `attribute_keys`, `attributes`, and `token_attributes`
- for minted canonical tokens, it does **not** parse `token_metadata.raw_json` to determine token state
- for minted canonical tokens, it reads `tokenToPlacement(tokenId)` from the main Terraforms contract
- for settled but unminted placements, bootstrap reads the current minted supply and `tokenToPlacement(1..totalSupply)`, then computes the placement complement inside the Terraforms max supply
- unminted placements use extension-owned synthetic token ids from `buildTerraformsUnmintedTokenId(...)`
- synthetic unminted rows write `tokens` with `record_kind = "extension_synthetic"`, `token_extension_artifacts`, and extension-owned normalized traits, but do **not** write canonical `token_metadata`
- it reconstructs the renderer inputs and fetches:
    - v2 `tokenURI(...)`
    - v2 `tokenHTML(...)`
- for `Daydream` and `Origin Daydream` modes it follows the canvas-override path before calling the v2 renderer
- for non-Terrain minted tokens it also writes a second artifact that forces the V2 renderer through Terrain status (`terraforms-v2-lost-terrain`)
- Terraforms mode transitions are one-way away from Terrain, so a Terrain refresh is not expected to remove an older lost-terrain artifact
- it derives the hidden renderer seed from placement -> level/tile and writes:
    - `Minted` as an extension-owned categorical trait
    - `Mode = Terrain` for every synthetic unminted row
    - `Seed` as a range trait
    - `Seed Class` for `X-Seed`, `Y-Seed`, and `Godmode` buckets
    - `Seasons = Season 0` when Beacon state shows the token's first antenna-on mutation happened before the fixed Season 0 cutoff
- Season 0 derivation reads current Beacon contract state during the Terraforms extension artifact refresh:
    - `getNumberOfAntennaModifications(tokenId)` gates the read
    - `getFirstAntennaModification(tokenId)` provides the earliest antenna mutation timestamp
    - the cutoff is fixed in the past, so the indexer does not add a separate historical Beacon log replay path for this trait
- real-token artifact refresh atomically writes the real token's extension artifacts and `Minted=true` traits while recording a durable retirement for the matching synthetic id
- delayed synthetic task retries no-op after that retirement marker instead of recreating the synthetic row

The resulting extension artifact rows become token-local choices under the
backend's snapshot media source. The read path can prefer or explicitly select
one of them to override effective `image` and `animationUrl` while leaving
canonical `token_metadata` untouched. Live renderer requests do not mutate or
reuse these artifact rows.

## Failure Behavior

- If URI resolution fails, the token is skipped.
- If fetch fails or returns invalid JSON, the token is skipped.
- Metadata is only written once, unless updated by a new fetch.

This is intentionally conservative and idempotent.

Collection-extension artifact failures are handled separately:

- the canonical metadata write is already committed
- the extension job retries on its own queue
- a terminal extension failure does not roll back the canonical metadata row
