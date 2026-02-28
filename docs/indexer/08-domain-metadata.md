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

## Failure Behavior

- If URI resolution fails, the token is skipped.
- If fetch fails or returns invalid JSON, the token is skipped.
- Metadata is only written once, unless updated by a new fetch.

This is intentionally conservative and idempotent.
