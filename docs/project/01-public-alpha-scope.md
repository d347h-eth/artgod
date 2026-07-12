# Public Alpha Scope

This document carries the launch-facing status material that used to live in
the root README. It is meant for public-alpha positioning and contributor
orientation. Deep implementation details stay in the component docs linked from
the README documentation map.

## Product and Release Positioning

ArtGod is a local-first desktop app for NFT collection indexing, exploration,
market data, and trading workflows. The public alpha is intended to make the
current local platform usable and inspectable without turning ArtGod into a
centralized hosted service.

Core release characteristics:

- free and copyleft open source under `AGPL-3.0-only`
- cross-platform desktop direction through Tauri
- local backend, workers, queue broker, and SQLite database
- public blockchain and marketplace API integration instead of centralized
  ArtGod servers
- operator-owned configuration, wallet custody, and local runtime state

## Current Implementation Snapshot

- Multi-runtime indexer is active and queue-driven with NATS JetStream and
  SQLite.
- Realtime sync, backfill sync, and reorg checks are implemented.
- Collection bootstrap is implemented: metadata first, optional local token
  image cache, then ownership snapshot plus short backfill.
- Fresh installs seed Terraforms as the first prepared collection row, visible
  for manual `start bootstrapping` or immediate purge without writing token or
  bootstrap data.
- Domain projections for orders, metadata, and activities are implemented.
- Offchain ingestion includes OpenSea live stream ingestion, bootstrap
  snapshots, periodic reconciliation, and normalization into canonical order
  state.
- Collection extensions are build-bundled and DB-activated; Terraforms is the
  first embedded extension for metadata-side artifacts, sync enrichment, and
  backend media overrides.
    - Terraforms collection browsing separates the `snapshot` / `live` source
      from token-local renderer choices. Snapshot can expose canonical media,
      the cached V2 artifact, and the token's V2 lost-terrain artifact; live
      preview can render V2, V1, or V0 directly from one pinned chain state.
    - `prefer V2` is enabled by default and remains explicit URL state
      when a user disables it. Request-time live media bypasses preview caches
      and adjacent-token prefetch.
- Userland collection browsing includes shared collection-page chrome, tokens,
  activities, holders, reusable trait facets, collection activity feeds, and
  owner-scoped token browsing.
- Blockspace exploration is implemented with stacked isometric levels, stable
  bucket ranges, live coverage refresh, manual backfill selection, and public
  single-collection cache diagnostics.
- Local observability stack is available for logs, metrics, traces, and
  profiles.
- Tauri desktop runtime supervisor composes local NATS, backend, and indexer
  workers from production runtime artifacts.
- Public release CI produces GPG-signed Linux x64 bundles and a universal
  Developer ID-signed, notarized, and stapled macOS DMG with signed checksums
  and GitHub build provenance. Windows release packaging remains deferred.
- Desktop Admin UI includes header launch, logs, stop, and shutdown actions plus
  system, wallets, and bots surfaces behind the native Tauri shell.
- Desktop wallet custody is implemented with Rust-owned Ethereum keystore
  storage, native secret prompts, and one-shot stdin secret handoff into
  wallet-bound trading runtimes.
- Bidding runtime is operational with DB-backed job management, secure wallet
  unlock, direct OpenSea bidding and snapshot lanes, WETH allowance bootstrap,
  and live command reconciliation.
- Bid-book UI is implemented for collection bidding and token detail pages,
  sourcing from the live/fresh bot snapshot projection when bidding is active
  and from canonical orders otherwise.
- Bidding automation UI is implemented for token, trait, and collection targets,
  with reusable token-card selection, contextual bid drafts, collection price
  tiers, staged tier reapply, and shared bidding panels.

Canonical backlog and priorities live in
`docs/progress/indexer/15-unified-backlog.md`.

## Project Structure

- `backend/`: Node.js API server in TypeScript.
- `frontend/`: SvelteKit UI for web, userland, and desktop Admin targets.
- `indexer/`: runtime workers, domain logic, infra adapters, and tests.
- `trading/`: wallet-bound bot runtimes and stdin secret-envelope bootstrap.
- `shared/`: shared TypeScript utilities, config contracts, read models, and
  database access.
- `database/`: SQLite migrations and storage roots.
- `observability/`: Grafana, Loki, Tempo, Pyroscope, Alloy, and Prometheus
  provisioning.
- `scripts/`: local development, build, config, debug, and release helpers.
- `src-tauri/`: Tauri desktop wrapper and Rust-owned desktop services.
- `docs/`: architecture references, runtime guides, progress plans, and backlog.

## Public Alpha Boundaries

- The desktop app is the primary user autonomy path: backend, workers, database,
  wallet custody, and bot runtimes run locally.
- The deploy stack is a public read-only browse surface for a fixed collection,
  not a centralized multi-user ArtGod control plane.
- Public write/admin routes are intentionally not exposed in public
  single-collection mode.
- OpenSea integration is optional in local desktop composition and capability
  gated by config.
- Extension behavior is build-bundled and DB-activated; remote or dynamically
  loaded extensions are not part of the alpha scope.
- Append-only migrations may seed prepared collection rows; the current
  fresh-install preset is Terraforms collection ID 1 with no out-of-box token or
  run data.

### Wallet and Bidding Security Assumptions

Public-alpha bidding assumes a dedicated wallet funded only with the WETH and
ETH the operator is prepared to expose to alpha automation risk.

- Stopping the bot, process death, or the end of a mandate generation does not
  cancel already signed OpenSea orders or revoke the onchain conduit allowance.
  Offchain cancellation remains available for tracked orders outside the
  placement mandate; cancellation and wallet funding or allowance changes
  remain deliberate operator actions.
- ArtGod relies on operator-selected RPC endpoints as truthful chain-state
  inputs. Selecting and maintaining truthful endpoints is an operator
  responsibility; the public alpha does not independently verify them.
- Userland and loopback job mutations are untrusted proposals. The running bot
  enforces the reviewed price and quantity caps on each offer, but aggregate
  strategy abuse within an authorized collection is an accepted alpha risk.

The complete custody and threat-model boundary is in
`docs/desktop/03-wallet-keystore-and-bot-unlock.md`; bidding-specific runtime
behavior is in `docs/trading/01-bidding-runtime-and-jobs.md`.

## Related Docs

- `README.md`: compact project overview, quick start, and documentation map.
- `docs/development/01-local-development.md`: long-form local setup,
  configuration, versioning, and command reference.
- `docs/desktop/01-tauri-build-and-runtime.md`: desktop build, runtime,
  supervisor, and release pipeline details.
- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`: wallet custody and the
  public-alpha wallet and bidding threat model.
- `docs/deploy/01-web-hosted-read-only.md`: hosted public read-only deployment.
- `docs/indexer/00-overview.md`: indexer runtime topology and invariants.
- `docs/trading/01-bidding-runtime-and-jobs.md`: bidding runtime current state.
- `docs/trading/02-bidding-automation-capabilities.md`: user-facing bidding
  automation capability reference.
