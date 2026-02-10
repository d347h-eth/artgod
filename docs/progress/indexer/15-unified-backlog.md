# Indexer Unified Backlog (Audit Consolidation)

This file is the single prioritized backlog for indexer work that is still open after auditing:

- `docs/blueprint/*.md`
- `docs/progress/indexer/*-gaps.md`
- `docs/progress/indexer/08-deferred.md`
- `docs/progress/indexer/09-short-term-roadmap-part-2.md`
- `docs/progress/indexer/10-short-term-roadmap-part-3.md`
- `docs/progress/indexer/11-token-sets-plan.md`
- `docs/progress/indexer/12-chain-identity-refactor.md`
- `docs/progress/indexer/13-trait-stats-recompute-plan.md`
- `docs/progress/indexer/14-bootstrap-metadata-first.md`

Priority legend:

- `P0`: correctness and production safety blockers
- `P1`: core feature completion for orderbook/indexing quality
- `P2`: scalability/reliability improvements
- `P3`: long-term architecture/refactor work

## P0: Correctness and Safety

- [ ] `BKL-001` Implement `order-updates-by-maker` actual revalidation logic (currently stub/no-op).
  Sources: `docs/blueprint/04-job-queueing.md`, `docs/progress/indexer/09-short-term-roadmap-part-2.md`, `indexer/src/infra/domain/orders.ts`
- [ ] `BKL-002` Add partial-fill accounting and quantity progression in `orders` (`filled` vs partial state transitions).
  Sources: `docs/blueprint/03-data-structures.md`, `docs/progress/indexer/03-data-structures-gaps.md`
- [ ] `BKL-003` Extend Seaport fill decoding beyond current basic paths to cover complex fulfill/match variants (`fulfillAvailable*`, `match*`) where feasible without traces.
  Sources: `docs/blueprint/07-fills-decoding.md`, `docs/progress/indexer/09-short-term-roadmap-part-2.md`
- [ ] `BKL-004` Add Blur fill decoding without traces for direct-call cases first; keep router/delegatecall heuristics as explicit follow-up.
  Sources: `docs/blueprint/07-fills-decoding.md`, `docs/progress/indexer/08-deferred.md`, `docs/progress/indexer/09-short-term-roadmap-part-2.md`
- [ ] `BKL-005` Implement targeted zero-log retry predicate (not blanket retry) for eventual-consistency RPC cases.
  Sources: `docs/blueprint/02-sync-pipeline.md`, `docs/progress/indexer/08-deferred.md`, `docs/progress/indexer/07-short-term-roadmap.md`
- [ ] `BKL-006` Remove token-set criteria-root fragility for non-decimal/scientific payloads and make parse/validation deterministic.
  Sources: `docs/progress/indexer/11-token-sets-plan.md`, `indexer/src/infra/token-sets/sqlite.ts`
- [ ] `BKL-007` Add bootstrap path for non-`ERC721Enumerable` collections using explicit user inputs (first token ID + total supply and/or token ID list), with preflight contract checks and explicit user sign-off before bootstrap starts.
  Sources: `docs/progress/indexer/08-deferred.md`, `docs/progress/indexer/10-short-term-roadmap-part-3.md`
- [ ] `BKL-008` Add bootstrap metadata failure remediation jobs (`failed_terminal` retry/resume workflows) so strict/best-effort outcomes are recoverable without manual DB edits.
  Sources: `docs/progress/indexer/14-bootstrap-metadata-first.md`
- [ ] `BKL-030` Harden bootstrap anchor resolution by validating `rpc.getBlock(anchorBlock)` result and failing early on missing/invalid anchor payload.
  Sources: `indexer/src/runtime/bootstrap-worker.ts`, user notes
- [ ] `BKL-031` Make bootstrap backfill collection-scoped end-to-end: when a bootstrap backfill job carries `collectionId`, sync execution must honor that scope instead of syncing all active collections.
  Sources: `indexer/src/runtime/bootstrap-worker.ts`, `indexer/src/runtime/sync-worker.ts`, user notes
- [ ] `BKL-032` Replace bootstrap completion checks based on global `countBlocksInRange()` with explicit collection-scoped progress tracking and catch-up scheduling until the collection reaches current head.
  Sources: `indexer/src/runtime/bootstrap-worker.ts`, user notes

## P1: Core Product Completion

- [ ] `BKL-009` Replace OpenSea fixture replay adapter with real OpenSea stream adapter (auth, reconnect, resubscribe, heartbeat, drop policy).
  Sources: `docs/blueprint/05-offchain-indexing.md`, `docs/progress/indexer/05-offchain-indexing-gaps.md`, `indexer/src/runtime/opensea-stream-worker.ts`
- [ ] `BKL-010` Add manual sync/backfill trigger interface (CLI/admin API contract) for explicit historical range scheduling.
  Sources: `docs/blueprint/02-sync-pipeline.md`, `docs/progress/indexer/02-sync-pipeline-gaps.md`
- [ ] `BKL-011` Add manual metadata refresh hooks (single token/range/collection) as first-class operator controls.
  Sources: `docs/blueprint/05-offchain-indexing.md`, `docs/progress/indexer/05-offchain-indexing-gaps.md`
- [ ] `BKL-012` Add mint-focused metadata trigger path (separate from transfer and ERC-4906 paths) for clearer metadata initialization semantics.
  Sources: `docs/blueprint/05-offchain-indexing.md`, `docs/progress/indexer/05-offchain-indexing-gaps.md`
- [ ] `BKL-013` Persist fill fee breakdown and classification (`marketplace` vs `royalty`) from event-level payment data.
  Sources: `docs/blueprint/07-fills-decoding.md`
- [ ] `BKL-014` Add collection owner count recalculation jobs (`distinct owner` aggregates) as domain derivative state.
  Sources: `docs/blueprint/04-job-queueing.md`, `docs/progress/indexer/01-architecture-gaps.md`
- [ ] `BKL-015` Revisit transfer uniqueness key to include explicit batch discriminator semantics for ERC-1155 edge cases.
  Sources: `docs/blueprint/03-data-structures.md`, `docs/progress/indexer/03-data-structures-gaps.md`
- [ ] `BKL-016` Harden criteria-order ingest behavior when metadata coverage is incomplete (today fallback can accept payload root with empty local membership).
  Sources: `docs/progress/indexer/11-token-sets-plan.md`, `indexer/src/infra/token-sets/sqlite.ts`
- [ ] `BKL-033` Extend WETH maker-trigger decoding with `Deposit` and `Withdrawal` events in addition to `Transfer` and `Approval` for better order revalidation coverage.
  Sources: `indexer/src/application/ft/weth.ts`, user notes
- [ ] `BKL-034` Add post-bootstrap cleanup policy and jobs for `nft_balance_snapshots` and successful rows in `bootstrap_metadata_snapshot_tasks` (while retaining failed rows for manual redrive).
  Sources: `docs/progress/indexer/14-bootstrap-metadata-first.md`, user notes
- [ ] `BKL-035` Add a database index covering `orders.side` for orderbook query patterns.
  Sources: user notes
- [ ] `BKL-036` Align smoke test config path with runtime config loading; avoid direct `runtimeEnv` reads for `WETH_ADDRESS`.
  Sources: user notes

## P2: Scalability and Reliability

- [ ] `BKL-017` Implement backfill write-buffer queue for `nft_balances` to reduce contention under heavy historical workloads.
  Sources: `docs/blueprint/02-sync-pipeline.md`, `docs/blueprint/06-fault-tolerance.md`, `docs/progress/indexer/08-deferred.md`, `docs/progress/indexer/09-short-term-roadmap-part-2.md`
- [ ] `BKL-018` Add shared cache/lock adapter strategy for multi-worker deployments (cache stampede and duplicate expensive work control).
  Sources: `docs/blueprint/06-fault-tolerance.md`, `docs/progress/indexer/10-short-term-roadmap-part-3.md`
- [ ] `BKL-019` Standardize retry and backoff policy across queues/jobs (not only broker redelivery and selective custom flows).
  Sources: `docs/blueprint/04-job-queueing.md`, `docs/progress/indexer/04-job-queueing-gaps.md`
- [ ] `BKL-020` Add batch-consumption and throughput controls where safe (consumer-level batching, queue-specific knobs).
  Sources: `docs/blueprint/04-job-queueing.md`, `docs/progress/indexer/04-job-queueing-gaps.md`
- [ ] `BKL-021` Move reorg block-check scheduling toward persistence-coupled and/or delayed tiered checks (not scheduler-only cadence).
  Sources: `docs/blueprint/02-sync-pipeline.md`, `docs/progress/indexer/02-sync-pipeline-gaps.md`, `docs/progress/indexer/06-fault-tolerance-gaps.md`
- [ ] `BKL-022` Add transaction fetch mode controls (per-tx batching vs full-block tx fetch for trusted backfill nodes) with provider capability guards.
  Sources: `docs/progress/indexer/08-deferred.md`
- [ ] `BKL-023` Improve bootstrap backfill completion polling with adaptive/backoff strategy after collection-scoped progress tracking is in place.
  Sources: `docs/progress/indexer/08-deferred.md`, `docs/progress/indexer/15-unified-backlog.md` (`BKL-032`)
- [ ] `BKL-024` Add queue depth/backpressure controls and operational scaling signals as explicit runtime policy.
  Sources: `docs/blueprint/01-architecture-overview.md`, `docs/progress/indexer/01-architecture-gaps.md`
- [ ] `BKL-037` Add concurrency controls for bootstrap ownership snapshot and token ID enumeration paths (similar to metadata concurrency controls).
  Sources: `indexer/src/runtime/bootstrap-worker.ts`, user notes
- [ ] `BKL-038` Move well-known on-chain contract addresses from env/config into DB-backed canonical address registry (for example `canonical_addresses` by chain + role).
  Sources: user notes
- [ ] `BKL-039` Introduce attribute key typing/policy (categorical vs scalar/high-cardinality) to avoid over-normalizing non-set-like attributes into huge `token_attributes` cardinality.
  Sources: user notes

## P3: Long-Term Architecture

- [ ] `BKL-025` Perform chain identity refactor (`chain_pk` internal key + `public_chain_id` external key + mapping table).
  Sources: `docs/progress/indexer/12-chain-identity-refactor.md`
- [ ] `BKL-026` Refactor function-oriented flows into explicit use-case/domain objects where beneficial (`SyncBlock`, `ProcessLog`, `BackfillRange`, etc.).
  Sources: `docs/blueprint/01-architecture-overview.md`, `docs/progress/indexer/01-architecture-gaps.md`
- [ ] `BKL-027` Decide and document Focus Mode policy (implement explicit gate, or formally close as out-of-scope for ArtGod bootstrap model).
  Sources: `docs/blueprint/05-offchain-indexing.md`, `docs/progress/indexer/02-sync-pipeline-gaps.md`
- [ ] `BKL-028` Add optional analytics/search pipeline jobs (activity indexing fan-out) if product scope needs it.
  Sources: `docs/blueprint/04-job-queueing.md`, `docs/progress/indexer/04-job-queueing-gaps.md`

## Maintenance

- [ ] `BKL-029` Refresh stale `*-gaps.md` files to align with current implementation and reference this backlog as canonical priority ordering.
  Sources: `docs/progress/indexer/01-architecture-gaps.md` to `docs/progress/indexer/06-fault-tolerance-gaps.md`
