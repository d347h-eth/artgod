# Desktop Wallet Keystore Implementation Plan

This plan turns the desktop wallet custody spec into mergeable implementation slices.

Source spec:

- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`

The goal is to implement the wallet subsystem without weakening the custody model:

- WebView never sees raw private keys
- unlock always happens through a native prompt
- restart = prompt
- decrypted key material reaches Node only once at bot startup over stdin/pipe
- wallet storage uses the Foundry/Alloy standard Ethereum keystore path, not a custom crypto format

This plan is intentionally implementation-ready.

## Current Integration Points

These are the current files that matter most for the rollout.

Desktop Rust composition:

- `src-tauri/src/lib.rs`
- `src-tauri/src/runtime/config.rs`
- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

Desktop resource/build pipeline:

- `package.json`
- `scripts/build/build-runtime-artifacts.mjs`
- `scripts/build/prepare-desktop-runtime-resources.mjs`
- `scripts/build/prepare-desktop-sidecars.mjs`

Admin frontend:

- `frontend/src/routes/+layout.svelte`
- `frontend/src/lib/admin/components/AdminShell.svelte`
- `frontend/src/lib/admin/runtime/**`
- `frontend/src/lib/admin/wallets/**`
- `frontend/src/lib/admin/bots/**`
- `frontend/src/lib/components/DesktopRuntimeDrawer.svelte`
- `frontend/src/lib/runtime/lifecycle/adapters/tauri-runtime-port.ts`
- `frontend/src/lib/admin/runtime/store.ts`

Current state:

- the admin build is now a dedicated shell with `lifecycle`, `wallets`, `bots`, `logs`, and `status` tabs
- wallet metadata and bot control surfaces are already wired through the native Tauri command boundary
- the remaining follow-up work is desktop E2E automation and future strategy implementation rather than admin-shell scaffolding

## Delivery Rules

Each slice must preserve these rules:

1. No raw secret reaches the WebView.
2. No raw secret reaches backend HTTP.
3. No raw secret reaches `.env`, CLI args, or process env.
4. No session unlock cache, TTL, or silent restart reuse is allowed.
5. Core runtime fail-fast behavior stays intact while bot lifecycle is separated from it.
6. Wallet logic stays in Rust and follows explicit ports/adapters boundaries.
7. Bot-specific trading logic must not be mixed into the indexer package by convenience.

## Implemented Package Shape

### Rust Desktop App

The desktop app now uses a dedicated wallet subsystem under `src-tauri/src/wallet/`.

Suggested structure:

```text
src-tauri/src/
  wallet/
    mod.rs
    domain/
    application/
      use-cases/
    infra/
      storage/
      keystore/
      prompt/
    tauri/
```

### Native Secret Prompt Helper

Use a separate small Rust helper binary, not a Tauri page and not a JS-driven shell plugin flow.

Recommended source location:

```text
src-tauri/sidecars/artgod-secret-prompt/
```

Recommended bundle/staging model:

- build the helper as a standalone target
- stage it into a deterministic sidecar path before desktop bundle assembly
- register it through Tauri `bundle.externalBin`
- launch it from Rust through Tauri's official sidecar mechanism
- communicate with it over stdin/stdout structured messages

Do not use a JS-side shell plugin to launch the helper.

### Component Ownership

Component split:

- Tauri wallet commands
  : part of the main Tauri core process
- Tauri bot commands
  : part of the main Tauri core process
- Rust keystore service
  : part of the main Tauri core process
- secret prompt helper
  : separate sidecar process only for native secret input/output

This split is important because only the helper is out-of-process.
The actual wallet state and decrypt logic remain in the main Tauri Rust runtime.

### Trading Runtime Package

Implemented package decision:

- create a dedicated `trading/` workspace for wallet-bound bot runtimes

Do not put bidding/sniping runtime code into `indexer/`.

Reason:

- wallet-bound trading bots are a separate domain from indexing
- restart/unlock policy is different
- telemetry and runtime state should be separated cleanly

`trading/` is now part of the root workspaces and desktop runtime build pipeline.

## Slice Overview

1. Slice 0: Admin shell and desktop hardening baseline
2. Slice 1: Rust wallet core and file store
3. Slice 2: Native secret prompt helper and sidecar bundling
4. Slice 3: Wallet commands and admin metadata UI
5. Slice 4: Export flow and destructive-operation hardening
6. Slice 5: Supervisor split for wallet-bound bot runtimes
7. Slice 6: Trading runtime bootstrap and stdin secret protocol

The slices are intentionally ordered so early slices produce a usable wallet subsystem before bot code exists.

## Current Status

As of 2026-04-18:

- Slice 0 is complete.
- Slice 1 is complete.
- Slice 2 is complete.
- Slice 3 is complete.
- Slice 4 is complete.
- Slice 5 is complete.
- Slice 6 is complete, including the shared golden-fixture protocol tests and secret-leak guards around bot startup.

## Slice 0: Admin Shell and Desktop Hardening Baseline

Goal:

- prepare the desktop surfaces so wallet work can land without fighting the current admin-only drawer layout
- harden the Tauri WebView baseline before any wallet metadata UI is added

Primary files:

- `src-tauri/tauri.conf.json`
- `frontend/src/routes/+layout.svelte`
- `frontend/src/lib/components/DesktopRuntimeDrawer.svelte`
- `frontend/src/lib/runtime/desktop-runtime-store.ts`
- `frontend/src/lib/runtime/lifecycle/adapters/tauri-runtime-port.ts`
- `frontend/src/lib/runtime/lifecycle/ports.ts`

Tasks:

- replace the admin-target `+layout.svelte` behavior that renders only `DesktopRuntimeDrawer`
- introduce a minimal admin shell layout that can host:
    - runtime panel
    - wallet panel placeholder
    - future bot panel placeholder
- keep the userland build path unchanged
- add a strict Tauri CSP in `src-tauri/tauri.conf.json`
- ensure the admin build uses no remote scripts, fonts, or styles
- add explicit frontend separation between:
    - runtime lifecycle APIs
    - future wallet APIs
    - future bot APIs
- keep secret-related UI placeholders non-functional in this slice

Recommended frontend shape after this slice:

```text
frontend/src/lib/admin/
  components/
  runtime/
  wallets/
  bots/
```

Acceptance:

- admin build renders a stable admin shell instead of only the runtime drawer
- strict CSP is enabled and the admin build still loads correctly
- runtime drawer behavior still works
- no wallet secrets are collected anywhere yet

## Slice 1: Rust Wallet Core and File Store

Goal:

- implement the Rust-owned wallet domain, keystore format, passphrase policy, and filesystem storage without any UI dependency

Primary files:

- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/runtime/config.rs`
- new `src-tauri/src/wallet/**`

Recommended Rust dependencies:

- `alloy-signer-local` with keystore support
- `eth-keystore` only if direct compatibility or fixtures require it
- `zeroize`
- `uuid`
- `rand` or `getrandom`
- `thiserror`
- `serde` / `serde_json`
- additional Alloy primitives as needed for key validation/address derivation

Tasks:

- add a `wallet` module to `src-tauri/src/`
- define domain types:
    - `WalletId`
    - `WalletLabel`
    - `WalletAddress`
    - `WalletMetadata`
    - `WalletRecord`
    - `PassphrasePolicy`
- define use cases:
    - `ListWallets`
    - `ImportWallet`
    - `RemoveWallet`
    - `ExportWallet`
    - `UnlockWalletForBotStart`
- keep outbound port traits local to each use-case module
- add a Rust-owned wallet config section resolved from app-data:
    - wallet directory
    - metadata index path
    - optional helper sidecar path
    - bot unlock stabilization delay
- implement filesystem storage adapter:
    - `index.json`
    - `<wallet-id>.json`
    - atomic metadata writes
    - restrictive file permissions
- implement keystore adapter:
    - validate private key
    - derive EVM address
    - encrypt using Alloy keystore support
    - decrypt using Alloy keystore support
    - zeroize plaintext buffers
- avoid custom cryptography implementation in this slice
- define bounded unlock behavior explicitly in the service layer:
    - decrypt for one operation
    - do the operation
    - drop plaintext from the main Tauri process
- add test-only in-process prompt substitutes so use-case tests can run before the real helper exists

Acceptance:

- Rust tests cover standard keystore roundtrip, wrong-passphrase rejection, duplicate address detection, duplicate label detection, and atomic remove behavior
- at least one fixture-level test proves compatibility with the Foundry/Alloy keystore path
- wallet files are stored under app-data, not SQLite
- no Tauri command or frontend code is required to validate the core wallet module

## Slice 2: Native Secret Prompt Helper and Sidecar Bundling

Goal:

- create the Rust-only prompt path for private-key and passphrase entry
- make it available in both dev and bundled desktop builds

Primary files:

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/capabilities/default.json`
- new `src-tauri/crates/artgod-secret-prompt-protocol/**`
- new `src-tauri/sidecars/artgod-secret-prompt/**`
- new helper build/staging script under `scripts/build/`
- `package.json`
- `src-tauri/src/wallet/infra/prompt/**`

Tasks:

- create the helper binary project
- keep the helper visually minimal and dependency-light
- implement the helper as a tiny `winit + softbuffer` window, not a general GUI toolkit app
- bake prompt glyphs from a pinned Cozette hi-DPI BDF asset into generated Rust constants via the helper crate `build.rs`
- keep the sidecar build path responsible only for compiling and staging the finished helper binary
- avoid runtime font parsing and system font lookup inside the helper
- define a structured stdin/stdout contract between desktop app and helper
- support helper actions:
    - import prompt
    - unlock prompt
    - remove confirmation prompt
    - export confirmation prompt
    - export reveal window
- make sure only non-secret context is passed in command arguments
- return prompt results over stdout only
- accept secret reveal payloads on stdin where needed
- add a desktop build step to ensure the helper binary exists before bundle assembly
- register the helper in `bundle.externalBin`
- wire the official Tauri sidecar runtime path for:
    - dev runs
    - bundled desktop runs
- use Tauri's Rust sidecar API instead of plain `std::process::Command`
- initialize the shell plugin for Rust `ShellExt` without granting any `shell:*` permission to a WebView capability
- sanitize helper errors before they bubble upward

Acceptance:

- desktop Rust code can launch the helper in development and release builds
- helper returns structured prompt output for import/unlock flows over stdio
- no helper action relies on WebView or Tauri JS bridge execution

## Slice 3: Wallet Commands and Admin Metadata UI

Status:

- completed

Goal:

- expose the Rust wallet subsystem to the privileged admin UI without ever returning raw secret data

Primary files:

- `src-tauri/src/lib.rs`
- new `src-tauri/src/wallet/tauri/commands.rs`
- `frontend/src/lib/runtime/lifecycle/adapters/tauri-runtime-port.ts`
- new `frontend/src/lib/admin/wallets/**`
- `frontend/src/routes/+layout.svelte`
- `frontend/src/lib/components/DesktopRuntimeDrawer.svelte`

Tasks:

- add Tauri command handlers for:
    - `wallet_list`
    - `wallet_import`
    - `wallet_remove`
    - `wallet_get_status`
- keep command handlers thin and transport-only
- wire the wallet use cases in `src-tauri/src/lib.rs`
- create a wallet DTO surface that contains metadata only:
    - `walletId`
    - `label`
    - `address`
    - `assignedBotKinds`
    - `status`
- add a frontend wallet port separate from the runtime lifecycle port
- add an admin wallet panel that can:
    - list wallets
    - trigger import flow
    - trigger remove flow
    - show locked/assigned state
- after import or remove, refresh metadata via Tauri command results
- keep the runtime drawer intact as a sibling panel, not a mixed concern

Explicitly forbidden in this slice:

- HTML password fields for private keys
- HTML password fields for passphrases
- passing secrets through `invoke()` payloads

Acceptance:

- operator can import and remove wallets from the admin UI
- WebView only sees metadata and sanitized statuses
- browser storage remains irrelevant to the wallet flow

## Slice 4: Export Flow and Destructive-Operation Hardening

Status:

- export/reveal and native destructive confirmations completed
- bot-state-dependent remove blocking deferred until Slice 5 introduces real bot runtime state

Goal:

- complete the remaining high-risk wallet operations with the same native-only secret boundary

Primary files:

- `src-tauri/src/wallet/application/use-cases/export_wallet.rs`
- `src-tauri/src/wallet/infra/prompt/**`
- `src-tauri/src/wallet/tauri/commands.rs`
- `frontend/src/lib/admin/wallets/**`

Tasks:

- wire the existing `ExportWallet` use case through Tauri and the admin UI
- require native passphrase prompt plus explicit typed confirmation
- show plaintext key only inside the helper reveal window
- do not allow clipboard copy in the first implementation
- do not write plaintext export files in the first implementation
- require native typed confirmation for remove in addition to the passphrase prompt
- keep remove/export failures frontend-readable and sanitized
- add logging guards so wallet flows never write secret-bearing payloads

Bot-state-dependent remove blocking is intentionally deferred:

- block remove while a bot is running on that wallet
- block remove while wallet remains assigned to an enabled bot

Those rules need the real bot state machine from Slice 5 and should not be faked from static wallet metadata.

Acceptance:

- export works without exposing plaintext to WebView
- remove requires native typed confirmation plus passphrase verification
- remove/export failures are operator-readable but sanitized
- no clipboard or temp-file plaintext path exists

## Slice 5: Supervisor Split for Wallet-Bound Bot Runtimes

Status:

- completed

Goal:

- separate optional trading bots from the fail-fast core composition so wallet unlock policy can remain strict without destabilizing the base runtime

Primary files:

- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/src/runtime/mod.rs`
- `src-tauri/src/runtime/config.rs`
- `src-tauri/src/runtime/bot_runtime.rs`
- `src-tauri/src/wallet/application/use_cases/assign_wallet_to_bot.rs`
- `src-tauri/src/wallet/tauri/bot_commands.rs`
- new `frontend/src/lib/admin/bots/**`
- `package.json`
- `scripts/build/build-runtime-artifacts.mjs`
- `scripts/build/prepare-desktop-runtime-resources.mjs`
- new `trading/src/runtime/**`

Tasks:

- refactor runtime state into:
    - core composition state
    - bot runtime states
- introduce explicit bot state machine:
    - `disabled`
    - `locked`
    - `awaiting_unlock`
    - `starting`
    - `running`
    - `stopped`
    - `error`
- keep current core fail-fast behavior for:
    - NATS
    - backend
    - indexer workers
- ensure bot failure does not restart the full composition
- define critical runtime dependencies per bot kind
- force-stop only the bots whose declared critical dependencies become unhealthy
- add typed desktop config for the stabilization delay before unlock prompt
- add explicit wallet-to-bot assignment commands and persisted assignment metadata
- block wallet removal while a wallet remains assigned to any bot
- surface bot state independently in the admin UI
- pull in the minimal trading runtime bootstrap and stdin secret protocol so the split uses real bot artifacts, not placeholders

Important rule:

- this slice must not silently restart a bot with a remembered unlock

Acceptance:

- supervisor can track bot runtimes independently from core composition
- a bot crash or dependency loss stops only the affected bot and does not restart the full composition
- per-bot dependency health is explicit in the admin UI
- next bot start requires a fresh prompt

## Slice 6: Trading Runtime Bootstrap and Stdin Secret Protocol

Status:

- completed as part of Slice 5 delivery

Goal:

- create the cross-language secret handoff contract and prove it with a minimal bot runtime before bidding/sniping strategies exist

Primary files:

- `package.json`
- new `trading/package.json`
- new `trading/src/runtime/**`
- `scripts/build/build-runtime-artifacts.mjs`
- `scripts/build/prepare-desktop-runtime-resources.mjs`
- `src-tauri/src/runtime/supervisor.rs`
- `docs/desktop/02-runtime-registry-maintenance.md`

Tasks:

- add a new `trading/` workspace
- create one minimal bot runtime entrypoint that:
    - reads the stdin secret envelope
    - validates metadata
    - constructs an in-memory signer
    - zeroizes the original buffer best-effort
    - reports startup success/failure
- define the stdin secret envelope contract formally
- keep the protocol versioned
- add Rust-side writer and Node-side reader tests
- add a small golden-fixture test set so Rust and Node stay aligned on protocol shape
- extend desktop runtime build scripts to include the trading runtime artifacts
- update supervisor mapping for wallet-bound bot runtimes
- update runtime-registry docs once the package exists

Protocol rules:

- never pass key bytes by env var
- never pass key bytes by CLI arg
- never pass key bytes by temp file
- raw key bytes stay binary, not hex text

Acceptance:

- a minimal bot runtime can start successfully with a wallet through stdin handoff
- startup fails on malformed or missing payload
- process list and environment remain secret-free

## Future Idea: OS-Native Wrapping

OS-native wrapping or keychain integration is explicitly out of the planned rollout.

It may be revisited later as a separate future idea only after the base wallet subsystem is complete and stable.

If revisited later, the constraints remain:

- the base passphrase-encrypted Ethereum keystore path stays canonical
- app passphrase remains mandatory
- restart still means prompt
- OS-native wrapping must never become a silent unlock shortcut

## Suggested PR Breakdown

Recommended PR sequence:

1. PR 1: Slice 0
2. PR 2: Slice 1
3. PR 3: Slice 2
4. PR 4: Slice 3
5. PR 5: Slice 4
6. PR 6: Slice 5
7. PR 7: Slice 6

This keeps the riskiest boundaries small and reviewable.

## Test Matrix

Every slice touching secrets must be verified against these leak paths:

- Rust logs
- frontend console output
- backend/indexer logs
- process env
- process command line
- app-data plaintext files
- browser storage
- WebView shell-plugin capabilities and raw plugin IPC calls

Manual desktop verification should cover:

- Linux
- macOS
- Windows

Minimum manual scenarios:

- import wallet
- list wallet
- remove wallet
- export wallet
- start bot
- bot crash
- restart desktop app
- confirm restart requires a fresh prompt

## Explicit Deferrals

These stay deferred even after the wallet subsystem lands:

- wallet generation
- mnemonic import
- unattended bot restart
- session unlock cache
- unlock TTL
- clipboard-based export convenience
- backend HTTP wallet APIs

## Final Rule

If a later implementation step makes the system more convenient but causes the raw key to cross into WebView, backend HTTP, env vars, or silent restart paths, that step is wrong and should be rejected.
