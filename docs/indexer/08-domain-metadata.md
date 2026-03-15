# Metadata Domain

The metadata domain resolves token URIs and fetches token metadata for assets observed in transfer events.

Primary files:

- `indexer/src/infra/domain/metadata.ts`
- `indexer/src/infra/metadata/viem-token-uri.ts`
- `indexer/src/infra/metadata/http-fetcher.ts`

Schema:

- `database/migrations/004_metadata_schema.sql`

## Inputs

The metadata domain consumes `domain.metadata.sync` jobs with a block range. It scans the `nft_transfer_events` table to discover tokens that appear in that range.

## Metadata Refresh Jobs

Metadata refreshes are handled out-of-band via `domain.metadata.refresh` jobs. These jobs are produced by:

- **On-chain triggers**: the sync pipeline decodes ERC‑4906 `MetadataUpdate` / `BatchMetadataUpdate` logs via the trigger registry in `indexer/src/application/metadata/refresh-triggers.ts`.
- `MetadataUpdate` publishes token-level refresh jobs.
- `BatchMetadataUpdate` publishes range refresh jobs (`domain.metadata.refresh-range`) with a queue cursor.
- The domain worker processes range jobs in chunks (`METADATA_REFRESH_RANGE_CHUNK_SIZE`) and re-enqueues the next cursor until complete.
- **Offchain triggers**: the OpenSea stream `item_metadata_updated` event is normalized into a refresh job with a known `contract` + `tokenId`.

The refresh job payload carries a reason/source string so the metadata domain can log what triggered the refresh. The trigger registry is the extension point for future collection-specific metadata update events.

Collection extensions already participate in this path in v1, but through sync-worker enrichment rather than through the core ERC-4906 trigger registry:

- sync-worker resolves enabled extension watch specs for the tracked collections
- extension-specific logs are normalized into the same metadata refresh job shapes
- domain-worker consumes those jobs exactly like any other metadata refresh trigger

## Trait Stats Recompute

Trait counts are recomputed into `collection_trait_stats` through `domain.metadata.stats-recompute` jobs on the dedicated `metadata-stats` queue.

- Metadata sync enqueues recompute per touched collection.
- Metadata refresh (single and range/cursor mode) enqueues recompute on successful token updates.
- Bootstrap finalization enqueues recompute with reason `bootstrap-finalized`.
- Reorg backfill metadata sync is classified as `reorg-resync` for stats recompute jobs.
- Recompute strategy is replace-in-transaction for deterministic correctness:
    - delete existing stats rows for the collection.
    - insert fresh counts from normalized `token_attributes` + `attributes`.

## Token Discovery

For each block range:

- Query `nft_transfer_events` grouped by `(contract, token_id, kind)`.
- For each token, skip if metadata already exists in `token_metadata`.

## URI Resolution

`ViemTokenUriResolver` reads on-chain metadata:

- ERC721: calls `tokenURI(tokenId)`.
- ERC1155: calls `uri(tokenId)` and expands `{id}` placeholders to 64-char hex.

Metrics are recorded for latency and failures.

## Metadata Fetching

`HttpMetadataFetcher` fetches JSON metadata from a resolved URI:

- Supports `http://`, `https://`, and `ipfs://` (via gateway).
- Supports `data:application/json` URIs.
- Enforces a configurable timeout (default 10s).
- Normalizes attribute structures to a standard shape.

Results are stored in `token_metadata` with JSON strings for attributes and raw metadata.

## Canonical Metadata First, Extension Artifacts Second

Collection extensions do **not** replace the canonical metadata domain.

Current behavior:

1. canonical metadata resolution/fetch/normalization completes first
2. `token_metadata` and normalized attribute rows are committed
3. bootstrap-worker or domain-worker publishes `collection-extension.refresh-artifacts` as a side-effect if the collection has an enabled install
4. collection-extension-worker performs extension-specific artifact refresh and writes `token_extension_artifacts`

This split is intentional:

- canonical metadata stays authoritative for token identity and normalized traits
- extension logic can fail/retry independently
- bootstrap readiness and canonical metadata refreshes do not wait on extension artifact completion

## Terraforms-Specific Metadata Behavior

The first embedded extension, `terraforms`, shadows the metadata path in a very specific way:

- it always targets the Terraforms version-2 renderer artifacts, regardless of the token owner-selected renderer version
- it reads the normalized `Mode` attribute from SQLite joins over `attribute_keys`, `attributes`, and `token_attributes`
- it does **not** parse `token_metadata.raw_json` to determine token state
- it reconstructs the renderer inputs and fetches:
    - v2 `tokenURI(...)`
    - v2 `tokenHTML(...)`
- for `Daydream` and `Origin Daydream` modes it follows the canvas-override path before calling the v2 renderer

The resulting extension artifact row is then used later by backend read paths to override effective `image` and `animationUrl` while leaving canonical `token_metadata` untouched.

## Failure Behavior

- If URI resolution fails, the token is skipped.
- If fetch fails or returns invalid JSON, the token is skipped.
- Metadata is only written once, unless updated by a new fetch.

This is intentionally conservative and idempotent.

Collection-extension artifact failures are handled separately:

- the canonical metadata write is already committed
- the extension job retries on its own queue
- a terminal extension failure does not roll back the canonical metadata row
