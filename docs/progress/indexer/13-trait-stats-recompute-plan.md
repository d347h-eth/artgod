# Trait Stats Recompute Plan

This plan defines the first implementation for collection trait aggregation stats.
Scope is intentionally narrow: reliable recompute for ERC-721 collections, no incremental math yet.

## Goals

- Expose deterministic trait counts per collection from normalized metadata.
- Keep correctness across bootstrap, backfill, and reorg by using recompute (not deltas) in the first pass.
- Reuse existing queue/runtimes with explicit jobs and idempotent handlers.

## Non-Goals (First Pass)

- ERC-1155 trait stats.
- Real-time incremental updates per token mutation.
- Cross-chain refactor (`chain_pk` / `public_chain_id`).

## Proposed Data Model

### `collection_trait_stats`

- `chain_id INTEGER NOT NULL`
- `contract_address TEXT NOT NULL`
- `attribute_key_id INTEGER NOT NULL`
- `attribute_id INTEGER NOT NULL`
- `token_count INTEGER NOT NULL`
- `updated_at TEXT DEFAULT CURRENT_TIMESTAMP`
- `PRIMARY KEY (chain_id, contract_address, attribute_id)`

Notes:

- `attribute_id` already maps to (`attribute_key_id`, `value`) through `attributes`.
- This avoids duplicating free-form key/value text in stats rows.

## Recompute Algorithm (Phase 1)

Input: `chain_id + contract_address`.

1. Build aggregated counts from normalized rows:
    - `token_attributes` -> `attributes` -> `attribute_keys`
    - group by `attribute_id`
    - `COUNT(DISTINCT token_id)` for each attribute
2. In one DB transaction:
    - delete existing `collection_trait_stats` rows for the collection.
    - insert fresh aggregated rows.
3. Emit structured logs with collection + row count + duration.

Why recompute-first:

- Robust with reorg/rollback and bootstrap transitions.
- Easier to reason about correctness than partial delta math right now.

## Queue + Runtime Wiring

### New job kind

- `domain.metadata.stats-recompute`
- payload:
    - `chainId`
    - `contract`
    - `reason` (`metadata-sync`, `metadata-refresh`, `bootstrap-finalized`, `reorg-resync`)
    - `sourceJobId?`

### Worker placement

- Handle in `domain-worker` (same runtime as metadata domain).
- Use dedicated `metadata-stats` queue for backpressure/isolation and clearer observability.

### Idempotency / dedupe

- Use deterministic `jobId` key:
    - `metadata:stats:${chainId}:${contract}:${reason}:${timeBucket}`
- Use `10s` bucket dedupe to avoid queue storms during backfill.

## Trigger Points

Phase 1 triggers:

- After successful `MetadataRefresh` token update.
- After `MetadataSync` domain batch finishes for a range.
- Bootstrap/reorg triggers are deferred to phase 2.

Phase 2 triggers (later):

- Reorg worker after rollback+resync completion.

## API Read Model

First pass query should join stats rows to attributes/keys:

- filter by `chain_id + contract_address`
- return:
    - `key`
    - `value`
    - `tokenCount`
- sorted by `key`, then `tokenCount DESC`, then `value`.

## Tests

1. Unit:
    - recompute SQL logic over fixture rows.
    - dedupe job id bucket logic.
2. Integration:
    - metadata write -> stats-recompute job -> stats rows exist.
    - second recompute replaces rows cleanly (no duplicates).
3. Reorg safety:
    - rollback/reprocess sequence still yields deterministic counts.

## Suggested Delivery Phases

### Phase A

- [x] migration for `collection_trait_stats`.
- [x] repository/service for recompute.

### Phase B

- [x] queue job kind + domain-worker consumer.
- [x] trigger from metadata refresh + metadata sync completion.
- [x] deterministic 10s dedupe via jobId bucket.

### Phase C

- API surface to read trait stats.
