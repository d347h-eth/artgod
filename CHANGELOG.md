# Changelog

This file records notable changes for ArtGod users, following
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Curated entries begin with `0.1.3-alpha`; earlier releases remain available in
[GitHub Releases](https://github.com/d347h-eth/artgod/releases).

## Unreleased

### Changed

- Extra targets presets keep their source target fixed after creation. Editing
  changes only their extra targets; existing bidding jobs keep their selected
  versions until explicitly updated.

### Fixed

- Bidding authorization opens in a shorter, resizable window with visible Next
  and Cancel buttons. Long reviews continue through Next before wallet unlock.
- Bootstrap enumeration reports progress at roughly 1% intervals, keeping the
  step counter moving more often on slow RPC endpoints and small collections.

## 0.1.3-alpha - 2026-10-01

Changes since the previous published application release,
[v0.1.1-alpha.3](https://github.com/d347h-eth/artgod/releases/tag/v0.1.1-alpha.3).
Intermediate version bumps and test builds are included in this comparison.

### Release summary

- Improved collection setup, metadata inspection, and Art Blocks token ranges.
- More reliable startup, market data, order validation, and bidding updates.
- Dependency security fixes and verified Linux packaging inputs.

### Upgrade notes

- The storage upgrade permanently deletes existing per-event listing history
  and bid/cancellation activity history. Daily listing history starts afresh.
  Sales, transfers, artwork, metadata, ownership, settings, wallets, and bidding
  state are retained. If you need the old history or a rollback option, preserve
  the stopped runtime's SQLite database and NATS store together before upgrading;
  downgrade compatibility is not qualified.
- Desktop startup performs required queue checks and resumable database cleanup
  before starting the backend and workers. Large stores can take longer to start;
  Stop remains available, and `retry start` resumes committed cleanup after a
  failed attempt. Optional disk compaction may be skipped without blocking
  startup. See the
  [storage upgrade guide](https://github.com/d347h-eth/artgod/blob/main/docs/development/03-sqlite-storage-and-recovery.md#3-recovery-on-upgrade).
- Source installations that start the backend and indexer separately must run
  `yarn storage:recover` with the intended `ARTGOD_DB_PATH` and writers stopped
  before starting the upgraded services. Docker operators must use the
  [stop → recover → start procedure](https://github.com/d347h-eth/artgod/blob/main/docs/deploy/01-web-hosted-read-only.md#sqlite-storage-upgrade).
  Combined `yarn dev` and desktop startup run the preflight automatically.
- Direct bootstrap API clients must replace `supportsEnumerable` / `manualInput`
  with an explicit `scope`; manual ranges use `startTokenId` and `tokenCount`.
  OpenSea slug probes require `sample_token_id`. The bundled UI and CLI use the
  updated contracts; existing collections keep their stored token scope. See
  [bootstrap API operations](https://github.com/d347h-eth/artgod/blob/main/docs/indexer/14-collection-bootstrap.md#separate-api-operations).

### Added

- Sample-token metadata inspection beside the bootstrap form, with bounded
  original response text, formatted JSON, live check output, resource URLs, and
  separate image-cache measurements that can be retried after failure.
- Token-range suggestions for recognized Ethereum Art Blocks projects, including
  project identity, minted count, and configured maximum. Each suggested value
  requires an explicit apply action.
- Optional desktop bidding metrics and a Grafana dashboard for scan progress,
  unfinished work, command backlog, market-data freshness, bidding decisions,
  and resource use. The desktop endpoint is disabled by default and binds only
  to this computer's loopback interface.
- Read-only queue and order-processing inspectors to examine pending work and
  saved validation progress without consuming jobs or changing the database.

### Changed

- Public-alpha versioning now follows the manual convention
  `0.<milestone>.<shipped-update>-alpha`, without an additional alpha counter.
  Earlier version names remain unchanged.
- Bootstrap setup separates contract discovery from sample inspection and
  declared token scope. Checks are optional for manual setup, first token IDs
  require explicit entry or acceptance, and pasted NFT URLs can fill the contract
  and inspection sample without changing the selected scope.
- Listings now retain one permanent historical row per NFT, seller, and UTC day,
  preserving the last recorded price after expiry, cancellation, or sale.
  Current orderbooks still retain all known valid, unexpired asks and bids.
- Order processing coalesces repeated validation requests, resumes saved maker
  scans after restart, and prioritizes sale/cancellation and token-specific
  updates separately from broad scans. Bounded batches and shared chain reads
  reduce repeated work; repeatedly failing orders retain retries without
  holding up the rest of a maker scan.
- Ongoing market-data maintenance removes obsolete orders and replay markers,
  refreshes current daily listing prices, and logs low disk-space or large WAL
  observations. Default OpenSea snapshot and bidding offer pages increase from
  100 to 200 items to reduce pagination requests.

### Removed

- Bid-create, bid-cancel, and listing-cancel entries from activity feeds and new
  history recording. Cancellations still update orderbooks and bidding state.

### Fixed

- Transient SQLite write conflicts now receive bounded retries across backend,
  indexer, and trading writes instead of immediately failing the operation.
- Bid books no longer duplicate lifecycle rows or restore stale active-order
  evidence after cancellation when refreshed.
- OpenSea collection resolution verifies the exact owned sample token and its
  declared scope, avoiding incorrect project associations on shared contracts.
  Live collections without OpenSea readiness expose `start opensea sync`, and
  collection views show snapshot freshness.
- Valid Seaport bulk-signed listings are recognized and can recover through
  normal order validation instead of remaining incorrectly invalid.
- OpenSea sales with missing or malformed order hashes still trigger validation
  of the identified seller's token orders, allowing sold asks to be corrected
  without inventing an exact-order fill.
- Stale OpenSea validation hints no longer repeat unnecessary work, and long
  reconciliation passes renew their leases to avoid overlapping passes.
- Bidding shutdown stops admitting background refreshes and commands before
  waiting for active work to finish. Bid-book diagnostics distinguish skipped
  publication from successful publication.
- Desktop children no longer inherit development-only Node loaders that can
  break staged native dependencies. Sharp's updated runtime and native loaders
  are included in desktop packaging.
- Linux AppImage verification preserves stored file permissions, avoiding
  incorrect runtime-integrity failures caused by extraction.

### Security

- Updated application and transitive dependencies to address known advisories,
  including SvelteKit, devalue, Sharp/libvips, Undici, cookie, gRPC, fast-uri,
  and brace-expansion.
- Linux packaging now verifies pinned tool bytes and publication metadata and
  enforces a 30-day minimum age before building AppImage and `.deb` bundles.
  The existing signed-artifact publication flow is retained.
