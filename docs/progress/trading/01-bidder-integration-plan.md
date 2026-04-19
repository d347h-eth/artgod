# Bidder Integration Plan

Status: WIP
Current milestone: Slice 3 complete

## Progress Snapshot

- Slice 1 completed in `trading/`.
- The pure bidding core was ported with mechanical `autobid -> bidder` renames only.
- Ported artifacts currently include:
  - `MarketEvent`
  - bidding job/domain contracts
  - `Bidder`
  - `CollectionOfferSnapshotService`
  - market-event pipeline builder
  - `BidderRefresh`
  - upstream-equivalent bidding tests in Vitest
- Verification completed:
  - `yarn workspace @artgod/trading test`
  - `yarn tsc -b trading`
- No host-facing `autobid*` names remain in the current `trading/src` bidding port.
- Slice 2 completed in `trading/`.
- Added a typed trading config loader with the `BIDDING_*` env surface and dedicated OpenSea bot lanes.
- Added external JSON bidding job loading with runtime-state reset on load.
- The bidding runtime now validates config and loads the external jobs file before emitting `bot_ready`.
- Slice 3 completed in `trading/`.
- Added ArtGod-compatible safe adapters for process logging, SQLite metadata lookup, viem-based WETH balance reads, retry, and rate limiting.

This document is the implementation plan for porting the existing battle-tested bidding bot into ArtGod.

Scope of this document:

- bidding first
- sniping later
- preserve proven business behavior
- adapt ArtGod around the bot rather than rewriting the bot into ArtGod’s current orderbook model

This plan is intentionally implementation-oriented.

## Goals

- Bring the existing bidding bot into ArtGod without material business-logic changes.
- Keep the bot’s direct OpenSea stream plus REST/SDK model as the long-term architecture, not just a temporary first pass.
- Reuse ArtGod’s desktop wallet custody, runtime supervisor, admin controls, typed env loading, and local SQLite state where that does not change bidding behavior.
- Keep sniping out of scope until bidding is fully operational, stable, and running under ArtGod’s desktop runtime.

## Primary References

ArtGod references:

- `AGENTS.md`
- `README.md`
- `docs/desktop/01-tauri-build-and-runtime.md`
- `docs/desktop/02-runtime-registry-maintenance.md`
- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`
- `docs/indexer/00-overview.md`
- `docs/indexer/05-storage-and-schema.md`
- `docs/indexer/07-domain-orders.md`

Upstream source project `w47ch32` references:

- `docs/porting_bots.md`
- `docs/autobidding.md`
- `docs/pipeline.md`
- `docs/architecture.md`
- `docs/integrations.md`
- `src/usecase/bidder/autobidder.ts`
- `src/usecase/bidder/collection_offer_snapshot_service.ts`
- `src/adapter/opensea/bidding_service.ts`

## Hard Invariants

These are not optional first-pass tradeoffs. ArtGod must preserve them for bidding to remain reliable.

1. The bidder must keep its own dedicated authoritative collection-offer snapshot path.
2. The bidder must refresh that snapshot on normal cadence every 60 seconds.
3. The bidder must perform a blocking force-refresh on the hot path when the cached snapshot is older than 15 seconds.
4. OpenSea stream events are wake-up signals only. They are not authoritative market truth.
5. The current production observation is that OpenSea streams can miss roughly 30% of relevant events. The architecture must assume stream loss is normal.
6. Because stream loss is normal, polling and snapshot refresh are correctness requirements, not mere fallbacks.
7. The bidder must continue to use direct OpenSea REST/SDK reads for authoritative offer discovery and order operations.
8. ArtGod’s canonical `orders` table must not become the bidder’s source of truth for competitiveness decisions.
9. Separate OpenSea workloads must remain split into distinct bot lanes:
   `stream`, `bidding`, `snapshot`, and later `sniper`.
10. Those lanes must not share one combined key or one shared limiter by convenience.
11. Per-job execution must remain serialized.
12. High-priority paths must bypass unrelated tick backlog while still respecting the same job mutex.
13. Managed own-offers must remain scoped by job target, not by “all visible maker-owned offers”.
14. Bid expiration tracking and early renewal behavior must remain intact.
15. Runtime state remains in memory and is rebuilt on restart. ArtGod should not add persistence that changes this behavior during the initial port.
16. The bidding runtime may emit `bot_ready` only after its own bootstrap is genuinely complete.

## Naming Policy

ArtGod should not introduce new host-facing `autobid*` naming.

Mechanical renames are allowed and encouraged, as long as they do not change behavior.

Recommended naming mapping:

| Upstream name | ArtGod name |
| --- | --- |
| `Autobidder` | `Bidder` |
| `AutobidJob` | `BiddingJob` |
| `AutobidRefresh` | `BidderRefresh` |
| `AutobidActivationPort` | `BiddingActivationPort` |
| `autobid*` config fields | `bidding*` config fields |
| `AUTOBID_*` env vars | `BIDDING_*` env vars |

Rule:

- rename mechanically
- do not “clean up” logic while renaming
- do not combine rename work with behavior changes unless explicitly required for compatibility

## Host Boundary Decisions

ArtGod desktop should own:

- wallet assignment
- unlock prompt and secret envelope handoff
- supervised process lifecycle
- runtime artifact build and packaging
- desktop env loading
- process logs
- shared SQLite path resolution

The bidding runtime should own:

- direct OpenSea stream subscriptions for watched collections
- direct OpenSea REST/SDK reads for offer discovery
- direct order placement and cancellation
- collection-offer snapshot cache
- hot refresh pipeline ordering
- bidding job scheduling and state
- in-memory tracked order state

ArtGod shared SQLite may be reused for:

- token metadata and trait lookup
- collection identity and stored OpenSea slug lookup if useful

ArtGod shared SQLite should not be reused for:

- authoritative active-offer discovery
- competitiveness decisions
- replacing the bidder snapshot lane

## Packaging and Config Implications

The upstream repo loads local uncommitted TypeScript job modules.

That is not sufficient for ArtGod desktop packaged runtime because bundled runtime resources are not the right operator-edit surface.

Recommended ArtGod phase-1 config model:

- keep strategy/job config file-based
- store that file outside the bundled resources
- resolve it from desktop app-data or an explicit env path
- keep the file format simple and operator-editable

Recommended first pass:

- `BIDDING_JOBS_FILE` points to a JSON file under desktop app-data
- the runtime maps JSON DTOs into `BiddingJob` domain objects
- no admin UI job editor is required for the first working port

Important wallet/config difference from upstream:

- upstream uses env-provided maker key and maker address
- ArtGod must not do that
- the ArtGod bidder receives wallet material only through the existing secret envelope stdin path

## OpenSea Key Split

ArtGod indexer keeps its existing `OPENSEA_API_KEY` for indexer/offchain ingestion needs.

The bidding bot gets its own dedicated keys:

- `OPENSEA_STREAM_SECRET_KEY`
- `OPENSEA_BIDDING_SECRET_KEY`
- `OPENSEA_SNAPSHOT_SECRET_KEY`

Later sniping will add:

- `OPENSEA_SNIPER_SECRET_KEY`

Rules:

- do not reuse `OPENSEA_API_KEY` for the bidder
- do not merge bidder and snapshot traffic onto one key by convenience
- do not share one limiter instance across all bot lanes

## SDK Compatibility Note

The upstream repo used a local `opensea-js` portal dependency only because of a logger-injection bug in the SDK.

Current planning assumption:

- use the public `opensea-js` package in ArtGod
- do not depend on a private local portal fork
- if logger wiring still needs a workaround, solve it with a thin ArtGod-local adapter or wrapper, not a custom long-lived fork unless strictly necessary

Ethereum library preference:

- avoid adding `ethers` as a direct project dependency
- prefer `viem` and other Paradigm-led Ethereum/EVM libraries
- known planned exception: OpenSea SDK order-fulfillment flow inside the sniping bot may still require `ethers`
- treat that sniping fulfillment usage as a narrow compatibility exception, not a general dependency choice

## Recommended Trading Workspace Shape

Recommended ArtGod structure for the bidding port:

```text
trading/src/
  domain/
    bidding/
  application/
    use-cases/
      bidding/
  adapters/
    opensea/
    metadata/
    wallet/
    config/
    logging/
  runtime/
    bidding-bot-runtime.ts
```

Principles:

- preserve small use-case-local ports
- keep provider-specific logic inside adapters
- keep runtime composition explicit in the entrypoint
- avoid moving bidding logic into `indexer/`

## Rollout Slices

## Slice 1: Port Pure Bidding Core

Goal:

- move the proven bidding core into `trading/` with behavior intact

Scope:

- `MarketEvent`
- bidding job model
- `Bidder`
- `CollectionOfferSnapshotService`
- pipeline builder
- pipeline stages related to bidding
- upstream unit tests for bidding behavior

Rules:

- behavior parity first
- mechanical rename only
- convert tests to Vitest if needed, but keep assertions and scenarios equivalent

Acceptance:

- core bidding tests pass in ArtGod
- no new host-facing `autobid` names remain in the ported bidding code

Status:

- done

## Slice 2: Add Typed Trading Config and External Job Loading

Goal:

- replace upstream ad hoc env and local TS job file assumptions with an ArtGod-compatible runtime config boundary

Scope:

- typed `trading` config loader
- desktop env contract additions
- external JSON job file loader
- rename upstream `AUTOBID_*` surface to `BIDDING_*`

Recommended config groups:

- `BIDDING_ENABLED`
- `BIDDING_DRY_RUN`
- `BIDDING_POLL_MS`
- `BIDDING_MAX_CONCURRENT_JOBS`
- `BIDDING_BOOTSTRAP_CONCURRENCY`
- `BIDDING_OFFER_EXPIRATION_SECONDS`
- `BIDDING_COLLECTION_OFFERS_POLL_MS`
- `BIDDING_COLLECTION_OFFERS_TTL_MS`
- `BIDDING_ORDER_LOOKUP_MAX_PAGES`
- `BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION`
- `BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION`
- `BIDDING_JOBS_FILE`

Compatibility decisions:

- use ArtGod `RPC_URL`, not upstream `ETH_RPC_URL`
- do not introduce `ETH_MAKER_KEY`
- do not introduce `ETH_MAKER_ADDRESS`

Acceptance:

- no scattered `process.env` reads in bidding runtime logic
- bidding jobs load from a user-editable external file

Status:

- done

## Slice 3: Add ArtGod-Compatible Safe Adapters

Goal:

- adapt the parts of upstream that can safely change without affecting bidding behavior

Scope:

- logging adapter
- retry utility
- rate limiter
- token metadata repository
- WETH balance adapter

Recommended decisions:

- replace upstream file-based logger with ArtGod-compatible process logging
- read token metadata from ArtGod SQLite
- keep trait matching behavior equivalent to upstream

Metadata recommendation for first pass:

- use `token_metadata.attributes_json` because it is the closest low-risk fit to upstream trait parsing behavior
- only move to normalized `token_attributes` joins later if needed for performance or correctness

Acceptance:

- bidding runtime logs flow cleanly into ArtGod supervisor-managed process logs
- token hot refresh trait matching can run against ArtGod local metadata

Status:

- done

## Slice 4: Port OpenSea Bidding and Snapshot Adapters

Goal:

- preserve the upstream direct OpenSea authority model inside ArtGod

Scope:

- port `BiddingService`
- port snapshot source adapter
- create separate SDK/API clients and limiters for:
  - bidding
  - snapshot

Rules:

- no replacement with ArtGod `orders` table
- no collapse into one shared OpenSea lane
- keep order-recovery logic intact
- keep managed-offer scoping intact

Acceptance:

- adapter tests cover direct lookup, fallback lookup, placement, cancellation, and snapshot-backed offer discovery

## Slice 5: Port Direct OpenSea Stream and Bid Hot-Refresh Pipeline

Goal:

- preserve the upstream wake-up path without pretending it is authoritative

Scope:

- stream adapter
- event normalization
- per-collection watched stream listeners
- opponent-bid filter
- blocking snapshot-refresh stage
- bidder hot-refresh stage

Required ordering:

1. receive relevant bid event
2. if the hot refresh path is about to rely on snapshot-backed competition state and the snapshot is older than 15 seconds:
   refresh snapshot and wait
3. run bidder hot refresh

Rule:

- stream hot refresh remains an accelerator only
- periodic authoritative snapshot refresh remains the primary correction path for missed stream events

Acceptance:

- the pipeline order is explicit and tested
- a stale snapshot on the hot path blocks until refreshed before hot refresh continues

## Slice 6: Compose the Real Bidding Runtime

Goal:

- replace the current placeholder runtime with the actual bidding runtime composition

Bootstrap sequence:

1. read and validate the secret envelope
2. build the in-memory signer/wallet
3. load typed trading config
4. open ArtGod SQLite path where needed
5. load bidding jobs
6. create OpenSea clients and limiters
7. create snapshot service
8. register jobs in `Bidder`
9. bootstrap collection snapshots
10. bootstrap current token-job prices
11. attach stream listeners and bidding pipeline
12. start snapshot cadence
13. start bidder tick loop
14. emit `bot_ready`

`bot_ready` rule:

- do not emit readiness before snapshot bootstrap and current-price bootstrap complete

Acceptance:

- starting the bidding bot from the admin UI launches the real runtime
- runtime only transitions to `running` after true bidder bootstrap completion

## Slice 7: Desktop Runtime and Packaging Integration

Goal:

- wire the bidding runtime fully into ArtGod desktop operations

Scope:

- `.env.example`
- desktop config template generation
- runtime build artifacts
- runtime resource staging
- docs updates

Rules:

- keep wallet custody model unchanged
- keep existing bot start/stop/admin surfaces
- add only the env and docs needed for bidding runtime operation

Acceptance:

- packaged desktop runtime can start the bidder using dedicated bot keys
- no secret leaks to env or CLI

## Slice 8: Live Verification and Parity Hardening

Goal:

- prove behavior parity under real conditions before touching sniping

Verification areas:

- snapshot cadence runs every 60 seconds
- hot path blocks on stale snapshot over 15 seconds
- bidder remains competitive after missed stream events
- early expiration renewal works
- tracked-order recovery works across OpenSea visibility gaps
- per-job serialization holds under duplicated triggers
- restart rebuilds state cleanly after fresh unlock

Done means:

- the bidder runs under ArtGod desktop
- can be assigned a wallet, unlocked, started, stopped, and restarted
- preserves the upstream snapshot-driven competitiveness model

## Explicit Non-Goals For This Phase

Do not include these in the first bidding rollout:

- sniping port
- intent-signal monitor
- admin UI for editing bidding jobs
- replacing the direct OpenSea model with ArtGod indexed order state
- broad refactors for elegance that risk changing behavior

## Deferred Until Bidding Is Operational

Only after bidding is fully operational should ArtGod start:

- sniping runtime port
- intent-monitor port
- sniper-specific config and admin surfaces
- deeper refactors of the ported trading code

## Definition of Success

The bidding port is successful when:

- the real bidding runtime replaces the placeholder runtime in `trading/`
- the bot runs under ArtGod’s existing wallet-bound desktop supervisor
- no material bidding behavior was lost during the port
- authoritative offer discovery still comes from direct OpenSea snapshot plus SDK paths
- missed stream events do not invalidate competitiveness because snapshot polling remains intact
- sniping work has not yet started
