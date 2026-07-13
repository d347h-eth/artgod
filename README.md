# ArtGod

ArtGod is a local-first desktop platform for NFT collection indexing,
exploration, market data, and bidding workflows.

It is free and copyleft open source (`AGPL-3.0-only`). The system is built to
give network users more autonomy and agency: all services run locally instead of depending
on centralized servers. Blockchain RPC and marketplace APIs are
external inputs; ArtGod-owned state stays under the operator's control.

There is no funding, no sale, no airdrop, no farming, and no token.
Donations welcome: donations.artgod.eth

## What It Is

- Cross-platform desktop app built with Tauri, SvelteKit, TypeScript, Rust,
  SQLite, and NATS JetStream.
- Self-sufficient local runtime: backend API, indexer workers, trading bots,
  runtime supervisor, and Admin UI are composed on the user's machine.
- Opinionated local-first architecture: explicit config, durable local queues,
  SQLite persistence, extension side paths, and no hidden hosted control plane.
- Public-alpha software: useful for local operation and inspection, still early
  enough that internal schemas and workflows may change quickly.

## Main Features

- NFT collection indexing and exploration: prepared collection presets,
  collection bootstrap, token browsing, trait facets, activities, holders,
  owner-scoped views, token detail pages, and blockspace coverage exploration.
- Real-time market data sync and visualization: onchain sync, OpenSea snapshot,
  stream, and reconcile lanes, canonical order state, bid books, and customized
  content pages.
- Bidding automation: wallet-bound local bot runtime, DB-backed token, trait,
  and collection bidding jobs, price tiers, live command reconciliation, and
  bid-book feedback.
- Frontend customizations: collection extension system, extension-provided media
  selection, collection-owned presentation overrides, and Terraforms as the
  first bundled extension.
- Local operations: native Admin config, runtime control, wallet unlock,
  logs, optional observability stack, and desktop release packaging.

Wallet custody follows the same local-first model: imported EVM private keys are
stored by the Rust desktop layer as encrypted standard Ethereum keystore files,
separate from non-secret wallet metadata. Unlocking is per bot start, so the
decrypted key is handed to the local trading runtime for that launch rather than
cached as a reusable session.

For the current public-alpha scope and implementation snapshot, see
`docs/project/01-public-alpha-scope.md`.

## Quick Start

Requirements:

- Node and Yarn from `package.json`
- Rust from `rust-toolchain.toml` for desktop/Tauri work

Desktop development from a clean checkout:

```sh
yarn install --immutable
yarn build:sqlite-native
yarn dev:composition
```

The SQLite build step compiles the trusted local native binding while keeping
install scripts disabled for the rest of the dependency install.

Long-form setup, configuration, versioning, test, and command details live in
`docs/development/01-local-development.md`.

## Desktop Releases

Official desktop builds are published under
[GitHub Releases](https://github.com/d347h-eth/artgod/releases). The public
alpha ships Linux x64 AppImage and `.deb` bundles plus a universal macOS DMG.
macOS 13.5+ is required for the macOS bundle.
Windows can be built from source, but signed Windows release artifacts remain
deferred.

Each release includes `SHA256SUMS.txt`, its detached OpenPGP signature,
detached signatures for the Linux bundles, the public release key, and GitHub
build-provenance attestations. The signed checksum manifest covers every
published bundle, including the macOS DMG. The macOS app is additionally signed
with Apple Developer ID, notarized by Apple, and distributed with a stapled
notarization ticket.

### Release Key

The checked-in and release-attached public key is
[the ArtGod release public key](docs/desktop/keys/artgod-release-public.asc).
Verify both full fingerprints against this README and another
maintainer-controlled profile before trusting the imported key:

- Primary certification key: `2528300C396AFEDF062619626E5E8A9BC0ECD353`
- Current release signing subkey: `6ED7A34814FFF8BBAB94784AA4EE961CBD9F14AD`

Inspect the downloaded key before importing it:

```sh
gpg --show-keys --with-fingerprint --with-subkey-fingerprint artgod-release-public.asc
```

### Verify A Download

Download the selected bundle, `artgod-release-public.asc`,
`SHA256SUMS.txt`, and `SHA256SUMS.txt.asc` into one directory. Linux users
should also download the bundle's matching `.asc` file.

```sh
gpg --import artgod-release-public.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt

# Linux: verify the checksum and the bundle's direct detached signature.
sha256sum --ignore-missing --check SHA256SUMS.txt
gpg --verify "<linux-bundle>.asc" "<linux-bundle>"

# macOS: verify the checksum.
shasum -a 256 --ignore-missing --check SHA256SUMS.txt

# Optional online verification of the GitHub Actions build provenance.
gh attestation verify "<bundle>" -R d347h-eth/artgod
```

On macOS, after the checksum passes, open the DMG and app normally so Gatekeeper
evaluates the Developer ID signature and stapled notarization ticket. Do not use
a Gatekeeper bypass for an official release.

Release signing subkeys rotate before expiry while the offline primary key
anchors the project identity. Rotation updates the checked-in/release-attached
public key and the fingerprints published on maintainer-controlled profiles.
Revocation, rotation, and compromise-response details are in
`docs/desktop/05-linux-gpg-release-signing.md`; the complete maintainer release
procedure is in `docs/desktop/06-release-signing-runbook.md`.

## Operator Guide

After verifying the download, read the
[ArtGod Operator Guide](docs/project/02-public-alpha-starter-guide.md) before
starting ArtGod. It sets expectations for the public alpha, walks through a
safe first run, and explains OpenSea and RPC configuration, bidding safety,
metadata and media limitations, and where to send feedback.

## Documentation Map

Start here when navigating the repo:

- [ArtGod Operator Guide](docs/project/02-public-alpha-starter-guide.md): public
  alpha expectations, a safe first run, configuration guidance, bidding safety,
  and feedback channels.
- `docs/project/01-public-alpha-scope.md`: product positioning, current public
  alpha snapshot, project structure, and release boundaries.
- `docs/development/01-local-development.md`: local setup, desktop dev,
  config, versioning, release build pointers, and common commands.
- `AGENTS.md`: agent-specific rules, architecture constraints, repo
  contribution standards, and mandatory user-perspective UI review routing.

Core architecture and runtime:

- `docs/indexer/00-overview.md`: indexer purpose, runtime topology, invariants,
  high-level data flows, and code map.
- `docs/indexer/01-config-and-env.md`: runtime config loading and env contract.
- `docs/indexer/02-queues-and-jobs.md`: queue names, job envelopes, JetStream
  adapter, retry, and dead-letter behavior.
- `docs/indexer/03-scheduler-worker.md` through
  `docs/indexer/17-bootstrap-concurrency-audit.md`: focused indexer runtime,
  storage, domain, testing, port, bootstrap, fill decoding, blockspace, and
  concurrency references.
- `docs/ports/01-port-catalog.md`: local service port map.
- `docs/backend-api.openapi.yaml`: backend API contract.
- `docs/diagrams/`: desktop and bootstrap sequence diagrams.

Product domains:

- `docs/trading/01-bidding-runtime-and-jobs.md`: bidding runtime, jobs,
  snapshots, reconciliation, wallet boundary, and config surface.
- `docs/trading/02-bidding-automation-capabilities.md`: user-facing bidding UI
  capabilities and backend API coverage.
- `docs/extensions/01-collection-extensions.md`: extension registry, indexer
  hooks, backend presentation overrides, and Terraforms extension behavior.
- `docs/ui/00-user-perspective-and-language.md`: required user-eye workflow
  review, product language, identity, units, errors, cross-surface consistency,
  and rendered verification.
- `docs/ui/01-interaction-guidelines.md`: established UI interaction, layout,
  control, style-reuse, navigation, media-selection, and pagination contracts.
- `docs/ui/02-preview-modal-system.md`: preview modal security and sizing model.

Desktop, deploy, and operations:

- `docs/desktop/01-tauri-build-and-runtime.md`: Tauri build pipeline, desktop
  runtime supervisor, Admin UI, logging, release CI, and troubleshooting.
- `docs/desktop/02-runtime-registry-maintenance.md`: checklist for adding or
  removing desktop/indexer runtimes.
- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`: Rust-owned wallet
  custody, native secret prompt, and bot secret handoff.
- `docs/desktop/04-settings-manifest-process.md`: manifest-first settings
  workflow and generated env artifacts.
- `docs/desktop/05-linux-gpg-release-signing.md`: dedicated Linux release GPG
  key setup and CI signing flow.
- `docs/desktop/06-release-signing-runbook.md`: desktop signing, notarization,
  release secrets, and verification runbook.
- `docs/deploy/01-web-hosted-read-only.md`: public read-only hosted deployment
  shape.
- `docs/indexer/10-observability-and-metrics.md`: logs, metrics, traces,
  profiles, and Grafana wiring.
- `docs/rpc/01-http-rpc-interaction-catalog.md`: HTTP JSON-RPC call inventory.

Planning and backlog:

- `docs/progress/indexer/15-unified-backlog.md`: canonical prioritized indexer
  backlog.
- `docs/progress/indexer/`: indexer plans, audits, deferred work, and migration
  notes.
- `docs/progress/trading/`: bidding and trading implementation plans.
- `docs/progress/desktop/`: desktop wallet/runtime trust plans.
- `docs/progress/ui/`: UI-specific implementation plans.
- `docs/progress/terraforms/`: Terraforms static explorer context.

## License

ArtGod is licensed under `AGPL-3.0-only`. See `LICENSE`.
