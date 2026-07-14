# Tauri Build and Runtime Pipeline

This document describes the current desktop pipeline end-to-end:

1. how artifacts are built
2. how Tauri assembles the app
3. how the desktop runtime supervisor launches backend/indexer/NATS
4. how shutdown, restart, and cleanup behave
5. how release bundles are produced in CI

It is the canonical technical reference for desktop composition in this repository.

Project versioning is documented in `docs/development/01-local-development.md`.
For desktop releases, keep the shipped tag aligned with the root `package.json`
version (`v<root-version>`) and run `yarn sync:version` plus
`yarn check:version` before publishing release artifacts. Dry-run tags append
`-test.N`, where `N` is a positive integer, to the exact shipped tag.

For add/remove runtime registry maintenance, see:

- `docs/desktop/02-runtime-registry-maintenance.md`

For desktop wallet custody, native secret prompts, and bot unlock policy, see:

- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`

For deferred local runtime identity and browser trust-store work, see:

- `docs/progress/desktop/02-local-runtime-identity-and-browser-trust.md`

For release signing procurement and CI secret setup, see:

- `docs/desktop/06-release-signing-runbook.md`

For detailed Linux GPG release-key setup, rotation, and GitHub Actions secret
handling, see:

- `docs/desktop/05-linux-gpg-release-signing.md`

## Scope and Goals

The desktop build/runtime pipeline is designed to:

- keep frontend/backend/indexer/trading in one local executable wrapper
- keep core-composition runtime behavior explicit and fail-fast
- avoid relying on development launch commands in production desktop mode
- make release builds reproducible in public CI

The desktop shell does not replace backend/indexer/trading logic. It orchestrates existing runtimes.

## macOS Universal 2 Contract

Universal 2 has the normal macOS meaning: the shipped application supports
Intel `x86_64` and Apple silicon `arm64` natively. A fat Mach-O contains both
architecture slices. The `.dmg` is only a distribution container around the
`.app`; it is not itself a universal binary. Apple documents this model in
[Building a universal macOS
binary](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary).

ArtGod applies that contract to its complete executable runtime:

- the Tauri executable, bundled Node, bundled NATS, native secret prompt, and
  every staged `better-sqlite3` add-on are fat `x86_64` + `arm64` Mach-O files
- backend and indexer each carry the official Sharp and libvips packages for
  both macOS architectures; Sharp selects the pair matching `process.arch`
- the same DMG is mounted and exercised by required `macos-15` arm64 and
  `macos-15-intel` x64 release gates

The paired Sharp packages follow Sharp's documented
[cross-platform installation](https://sharp.pixelplumbing.com/install/)
contract rather than combining independently distributed package trees with
`lipo`. Tauri's target-aware packaging and sidecar naming are documented in its
[macOS build guidance](https://v2.tauri.app/distribute/app-store/) and
[external-binary guide](https://v2.tauri.app/develop/sidecar/).

## Executable Lifecycle Summary

1. Rust app process initializes and exposes runtime commands. Startup is
   deferred; there is no immediate supervisor auto-start in `setup`.
2. System tray is initialized with native actions: `open ArtGod in browser`,
   `open admin UI`, and `shutdown`.
3. Admin UI runs in the native Tauri window and exposes the privileged desktop
   control plane: `config`, `system`, `wallets`, `bots`, and header
   logs/open/stop/shutdown actions.
4. Userland UI runs in a regular browser tab and is served by the local backend
   origin.
5. Frontend boot lifecycle orchestrator initializes, waits for Tauri bridge
   readiness, then invokes `runtime_auto_start`; unconfigured installs and
   installs with `autostart infra` disabled stay stopped behind the Admin header
   action sequence.
6. When startup is requested, the supervisor starts local NATS from bundled
   `nats-server`, then backend, then enabled indexer workers from bundled
   resources using bundled Node and each runtime's isolated package-local
   dependencies. OpenSea workers are skipped when OpenSea integration is
   disabled, and wallet-bound trading bots are staged but start only on
   explicit operator action after unlock.
7. Boot lifecycle console stays visible until lifecycle backend readiness probe
   succeeds, not merely until process state is `running`.
8. Any core composition process exit triggers fail-fast full stack restart.
   Wallet-bound trading bots are supervised separately and stop only when they
   crash or when one of their declared critical dependencies becomes unhealthy.
9. Bot starts are generation-fenced from before unlock through controller
   publication. Stop remains available during authorization review and startup,
   cancels pending work, and waits for that generation to unwind.
10. Trading bots are parent-contained: stdin remains open after one exact
    secret frame as a portable liveness lease, with Linux and Windows native
    containment reinforcing parent death.
11. Every native wallet prompt is likewise a contained sensitive child. Its
    stdin stays open after one exact request so loss of the desktop owner closes
    import, unlock, remove, export-confirm, or export-reveal immediately.
12. Closing the admin window hides it. The runtime keeps running in the tray.
    Graceful runtime shutdown is triggered explicitly via tray `shutdown` or app
    exit.

## Build Commands

Root build/helper commands:

```sh
yarn install --immutable
yarn build:sqlite-native
yarn build:web
yarn build:userland
yarn build:admin
yarn build:desktop
yarn build:desktop:no-bundle
yarn build:runtime
yarn build:desktop-runtime
yarn build:desktop-runtime-resources
yarn build:desktop-sidecars --profile release
yarn test:desktop:listener-boundaries
yarn check:desktop-runtime-resources
yarn check:desktop-no-bundle-runtime
yarn check:linux-bundled-runtime <bundle-directory>
yarn prepare:tauri-linux-tools
yarn check:runtime-registry
yarn clean:build
yarn build:desktop:no-bundle --debug
```

`yarn tauri ...` resolves the project-pinned `@tauri-apps/cli` binary. The
desktop workflows do not require the separate Cargo `tauri` subcommand.

What each command does:

- `yarn build:sqlite-native [--if-needed]`
  : Runs `scripts/build/build-sqlite-native-binding.mjs`.
  : Uses the Tauri/Cargo target context when present and otherwise targets the build host.
  : Invokes only the trusted `better-sqlite3` package-local build path, produces a fat `x86_64` + `arm64` binding for the macOS universal target, and fails if the required output is missing or has the wrong architecture.
  : `--if-needed` reuses only an existing binding whose architecture, exact
  `better-sqlite3` version, Node version, and Node module ABI satisfy the
  active target.

- `yarn build:web`
  : Runs `scripts/build/build-frontend-target.mjs web`.
  : Uses `@sveltejs/adapter-node` and produces web/server artifacts under `frontend/build-web`.

- `yarn build:userland`
  : Runs `scripts/build/build-frontend-target.mjs userland`.
  : Uses `@sveltejs/adapter-static` and writes browser userland static output to `frontend/dist-userland`.

- `yarn build:admin`
  : Runs `scripts/build/build-frontend-target.mjs admin`.
  : Uses `@sveltejs/adapter-static` and writes native admin static output to `frontend/dist`.

- `yarn build:desktop`
  : Alias for `yarn build:admin`.

- `yarn build:desktop:no-bundle`
  : Runs the project-pinned Tauri CLI with `build --no-bundle --ci`.
  : Produces a release-mode executable and adjacent resources by default; optional Tauri arguments such as `--debug` and `--target` are forwarded by Yarn.
  : The Rust build reconciles only Tauri's copied runtime destination before the fresh staged resources are installed, so repeated builds do not require the broad `clean:build` command.

- `yarn build:runtime`
  : Runs `scripts/build/build-runtime-artifacts.mjs`.
  : Produces the full local/deploy backend, indexer, and trading runtime artifacts, including optional observability exporters, under workspace-local `dist-desktop` folders.

- `yarn build:desktop-runtime`
  : Runs the same artifact builder with the explicit desktop profile.
  : Selects dependency-free observability adapters and fails if Pyroscope, Datadog pprof, OpenTelemetry, or Prometheus enters the desktop graph.

- `yarn build:desktop-runtime-resources`
  : Runs `scripts/build/prepare-desktop-runtime-resources.mjs`.
  : Copies desktop-profile runtime artifacts and materializes only their reviewed native runtime dependencies into `src-tauri/resources/runtime`:
    - `backend/dist-desktop/*`
    - `backend/node_modules/*` (`better-sqlite3`, `sharp`, and their reviewed runtime closures)
    - `indexer/dist-desktop/*`
    - `indexer/node_modules/*` (`better-sqlite3`, `sharp`, and their reviewed runtime closures)
    - `trading/dist-desktop/*`
    - `trading/node_modules/*` (`better-sqlite3` and its reviewed runtime closure only)
      : Rejects Yarn project PnP hooks/state, unexpected dependency files, symbolic links, and full-profile artifacts.

- `yarn build:desktop-sidecars --profile release`
  : Runs `scripts/build/prepare-desktop-sidecars.mjs`.
  : Builds the native secret-prompt sidecar and stages the target-specific binary under `src-tauri/binaries`.

- `yarn check:desktop-runtime-resources`
  : Starts the staged bundled Node with ambient PnP variables removed and executes SQLite/Sharp smoke operations through every package-local runtime dependency tree.
  : Starts the staged bundled NATS, requires its ports file and initial client `INFO` frame to report exactly `127.0.0.1` with the same valid port, and verifies that socket accepts a connection.

- `yarn test:desktop:listener-boundaries`
  : Runs the exact Rust config and supervisor argument tests that require numeric IPv4 loopback for the installed backend and NATS processes, then starts the backend on an OS-assigned port and verifies Fastify bound the configured IPv4 interface.

- `yarn check:desktop-no-bundle-runtime`
  : Compares the complete staged runtime with the adjacent runtime produced by the preceding debug no-bundle build, including entry types, executable modes, and SHA-256 bytes.

- `yarn check:linux-bundled-runtime <bundle-directory>`
  : Extracts exactly one AppImage and `.deb`, rejects links, executable-mode changes, or file-set drift, and compares every packaged runtime file's SHA-256 with `src-tauri/resources/runtime`.
  : Also verifies the staged and packaged wallet-recipient closures against the immutable snapshot emitted when Rust generated the embedded integrity manifest.

- `yarn prepare:tauri-linux-tools`
  : Runs `scripts/build/prepare-tauri-linux-bundler-tools.mjs`.
  : Materializes the exact AppImage packaging executables declared by `config/tauri-linux-bundler-tools.json` only after size and SHA-256 verification.

- `yarn check:runtime-registry`
  : Runs `scripts/build/check-runtime-registry.mjs`.
  : Verifies runtime registry consistency across desktop build maps, supervisor mappings, dev launchers, and observability/metrics mappings.

- `yarn clean:build`
  : Runs `scripts/build/clean-build-artifacts.mjs`.
  : Removes dist and cache outputs across workspaces (`dist*`, `.vite`, `.vitest`, `.svelte-kit`, generated package-local runtime `node_modules`, `src-tauri/target`, `src-tauri/resources/runtime`, `src-tauri/binaries`, sidecar crate `target/*`).
  : Use this broad cleanup for recovery or deliberately cold builds, not as a prerequisite for repeated no-bundle QA.

## Tauri Build Hooking

`src-tauri/tauri.conf.json` contains:

- `beforeDevCommand = "node ./scripts/build/dev-frontend-target.mjs admin --prepare-desktop-sidecars=debug"`
- `beforeBuildCommand = "yarn build:sqlite-native --if-needed && yarn build:admin && yarn build:userland && yarn build:desktop-runtime && yarn build:desktop-runtime-resources && yarn build:desktop-sidecars --profile release && node ./scripts/build/macos-code-signing.mjs sign-staged"`
- `frontendDist = "../frontend/dist"`

This ensures `yarn tauri build ...` always has:

1. a native SQLite binding matching the active Tauri target
2. desktop frontend static output
3. browser userland static output
4. backend/indexer runtime `.mjs` artifacts
5. staged runtime resources under `src-tauri/resources/runtime`
6. staged native sidecar binaries under `src-tauri/binaries`
7. macOS signatures on staged Mach-O runtime resources and sidecars before
   Rust embeds the wallet-recipient integrity manifest

before final Tauri bundle generation starts.

During Rust compilation, `src-tauri/build.rs` derives the active Cargo profile
output from `OUT_DIR` and removes only its prior `resources/runtime` copy. On
Linux it then copies the validated staged tree beside the executable so
`--no-bundle` keeps the normal `resources/runtime` layout even though Linux
bundles use format-specific resource destinations. This applies equally to
default or custom Cargo target directories, explicit target triples, and debug
or release profiles. It preserves compiled dependencies, incremental caches,
executables, sidecars, and unrelated bundle output.
Release compilation also writes a deterministic wallet-recipient hash snapshot
beside the executable at the same moment the hashes are embedded. The final
Linux bundle verifier uses that snapshot so a later staging change cannot make
the package gate approve bytes that the executable would reject.

## Build Helper Scripts

### `scripts/build/build-frontend-target.mjs`

Responsibilities:

- receives explicit target (`web`, `userland`, or `admin`; `desktop` remains legacy alias to `admin`)
- exports target via:
    - `FRONTEND_BUILD_TARGET`
    - `VITE_FRONTEND_BUILD_TARGET`
- runs frontend workspace build
- SvelteKit adapter selection is handled in `frontend/svelte.config.js`:
    - `FRONTEND_BUILD_TARGET=admin` -> `@sveltejs/adapter-static` (`frontend/dist`)
    - `FRONTEND_BUILD_TARGET=userland` -> `@sveltejs/adapter-static` (`frontend/dist-userland`)
    - `FRONTEND_BUILD_TARGET=web` -> `@sveltejs/adapter-node` (`frontend/build-web`)

### `scripts/build/build-runtime-artifacts.mjs`

Responsibilities:

- cleans old runtime outputs
- builds backend/indexer/trading runtime entrypoints with `esbuild`
- writes a versioned full/desktop profile marker into every artifact directory
- validates the desktop metafile before artifacts can be staged
- writes:
    - `backend/dist-desktop/server.mjs`
    - `indexer/dist-desktop/*.mjs` (all worker entrypoints)
    - `trading/dist-desktop/*.mjs` (wallet-bound bot runtimes)

Current build strategy details:

- `bundle: true`, `format: "esm"`, `platform: "node"`
- native packages declared by `scripts/build/native-runtime-dependencies.mjs` are externalized (`better-sqlite3`, `sharp`)
- the default full profile retains optional metrics/tracing/profiling exporters for local and deploy runtimes
- the explicit desktop profile resolves APM and metrics to no-op adapters and rejects `@pyroscope/nodejs`, `@datadog/pprof`, `@opentelemetry/*`, and `prom-client` in the esbuild input graph
- Node `require` shim banner is injected for CJS dependencies bundled into ESM output
- explicit `tsconfigRaw` is provided so runtime build does not depend on frontend `.svelte-kit` TS config state

Native package note:

- `better-sqlite3` and `sharp` stay external so their package-local loaders can access the reviewed native files staged in each runtime's isolated `node_modules` tree.
- `.yarnrc.yml` keeps `enableScripts: false`; CI must not override it with `YARN_ENABLE_SCRIPTS=true`.
- `.yarnrc.yml` `supportedArchitectures` keeps the current host plus `x64` and `arm64` package variants available, so one immutable install can supply both reviewed macOS Sharp/libvips pairs.
- `better-sqlite3` is built through the explicit trusted step `yarn build:sqlite-native`, which targets the build host by default and builds then merges both macOS slices when the Tauri/Cargo target is `universal-apple-darwin`.
- the target-aware Tauri build hook uses `yarn build:sqlite-native --if-needed`
  so it reuses only a binding that satisfies the requested architecture,
  package version, Node version, and Node module ABI contract.
- `sharp` uses its optional `@img/*` prebuilt packages; universal macOS staging carries the official Darwin `x64` and `arm64` Sharp/libvips pairs and lets Sharp select by `process.arch`. It is not enabled through a broad post-install script policy.
- `scripts/build/check-native-runtime-dependencies.mjs` verifies the full PnP local/deploy build; desktop staging separately starts bundled Node and executes real SQLite and Sharp smoke operations through each isolated staged dependency tree.

### `scripts/build/prepare-desktop-runtime-resources.mjs`

Responsibilities:

- stages runtime resources for Tauri bundling under `src-tauri/resources/runtime`
- downloads/verifies the Node distribution for the target platform and stages bundled Node under `src-tauri/resources/runtime/node`
  : source of truth for Node version is `package.json` `engines.node`
  : an explicit distribution target must agree with any active Tauri/Cargo
  target context; absent either, resolution uses the other and then falls back
  to the build host
  : the universal macOS target downloads and merges the Intel and Apple silicon executables
  : downloaded archives are cached in `.cache/desktop-node-runtime`
- downloads/verifies the NATS server distribution for the target platform and stages bundled NATS under `src-tauri/resources/runtime/nats`
  : source of truth for NATS version is `DESKTOP_NATS_VERSION` build env (default `2.10.17`)
  : download target uses the same target resolution as Node
  : the universal macOS target downloads and merges the Intel and Apple silicon executables
  : downloaded archives are cached in `.cache/desktop-nats-runtime`
- copies:
    - `backend/dist-desktop/*`
    - `backend/node_modules/*`
    - `frontend/dist-userland/*`
    - `indexer/dist-desktop/*`
    - `indexer/node_modules/*`
    - `trading/dist-desktop/*`
    - `trading/node_modules/*`
    - `node/node` or `node/node.exe`
    - `nats/nats-server` or `nats/nats-server.exe`
- resolves locked package sources through build-time PnP, then copies only the explicit runtime file allowlist into package-local `node_modules`
- gives backend/indexer the SQLite and Sharp closures while keeping Sharp/libvips unresolvable from the key-bearing trading runtime
- stages the fat universal SQLite binding and both official macOS Sharp/libvips package pairs when the resolved target is `universal-apple-darwin`
- rejects project `.yarn`, `.pnp.cjs`, `.pnp.loader.mjs`, symbolic links, special files, missing packages, wrong build profiles, and unexpected package files
- starts the bundled Node executable with ambient PnP variables removed, executes an in-memory SQLite query for every runtime, and performs a real one-pixel Sharp conversion for backend/indexer
- starts the staged NATS binary with explicit numeric-loopback, JetStream, and
  isolated storage arguments on an OS-assigned port, requires its ports file and
  initial client `INFO` frame to agree on the host and valid port, and proves
  that socket accepts a connection before resource staging can succeed

### `scripts/build/prepare-desktop-sidecars.mjs`

Responsibilities:

- builds the native secret-prompt sidecar crate for the active target triple
- stages the built binary into `src-tauri/binaries/artgod-secret-prompt-<target-triple>(.exe)`
- stages a fat `artgod-secret-prompt-universal-apple-darwin` sidecar when Tauri builds the macOS universal target
- keeps sidecar build output separate from the main `src-tauri/target` tree by using `src-tauri/target/sidecars`

### `src-tauri/build/tauri_runtime_output.rs`

Responsibilities:

- derives the exact Tauri profile output directory from Cargo's `OUT_DIR`
- removes only the previously copied `resources/runtime` destination before
  `tauri-build` copies current resources
- treats missing output as already reconciled and fails the build on any real
  inspection or removal error
- removes a file or symbolic-link leaf without following it
- validates and copies the staged runtime into Linux no-bundle profile output without following symbolic links

### `src-tauri/tauri.linux.conf.json`

Responsibilities:

- removes the base Tauri resource copy for Linux bundles so the runtime is not duplicated
- places AppImage runtime resources under `/usr/share/ArtGod/resources/runtime`, outside linuxdeploy's `/usr/lib` ELF rewrite area
- keeps `.deb` runtime resources under `/usr/lib/ArtGod/resources/runtime`
- leaves the local no-bundle layout to the Rust build copy described above

### `scripts/build/macos-code-signing.mjs`

Responsibilities:

- signs staged macOS executable/loadable Mach-O files under `src-tauri/resources/runtime` and `src-tauri/binaries` before Rust embeds release integrity hashes and Tauri generates the final bundle artifacts
- covers the bundled Node runtime, bundled NATS runtime, staged native `.node` add-ons, and the native secret-prompt sidecar
- grants only the bundled Node executable the dedicated `com.apple.security.cs.allow-jit` entitlement required by V8 under hardened runtime; NATS, native libraries, the Tauri executable, and the secret-prompt sidecar do not receive that exception
- skips non-macOS targets and local macOS builds without `APPLE_SIGNING_IDENTITY`
- mounts the produced DMG, verifies that Node's embedded entitlements exactly match `src-tauri/entitlements/node-runtime.plist`, verifies the contained `.app` signatures, and starts Node far enough to initialize V8 before notarization

### `scripts/build/prepare-tauri-linux-bundler-tools.mjs`

Responsibilities:

- owns the complete Tauri Linux x64 AppImage tool cache contract
- requires the manifest CLI version to match the project-pinned Tauri CLI
- verifies every downloaded tool's exact size and repository-owned SHA-256 before making it executable
- atomically replaces stale or Tauri-mutated cache entries before each release bundle
- prevents missing manifest entries from falling through to Tauri's moving upstream downloads

### `scripts/build/macos-notarization.mjs`

Responsibilities:

- verifies and hashes the signed DMG before submission
- submits once without coupling upload to Apple's processing wait
- persists the submission ID and retries transient status-query failures
- redacts credentials from live child-process output, errors, and saved diagnostics before emission
- verifies Apple's accepted log against the preserved DMG SHA-256
- staples immediately or resumes the same submission and DMG from a later
  manual workflow run

### `scripts/build/secret-output-redaction.mjs`

Responsibilities:

- keeps raw signing-tool output internal while streaming only credential-redacted text
- redacts exact, serialized, multiline payload, authorization-header, and JWT-shaped credential forms
- sanitizes child-process failures and diagnostic files through the same boundary

### `scripts/build/linux-gpg-signing.mjs`

Responsibilities:

- signs and verifies Linux bundles and the release checksum manifest through one implementation
- imports only the configured release key into an isolated temporary GPG home
- validates the exact primary fingerprint and available signing key/subkey before signing
- supplies the passphrase over a file descriptor rather than process arguments
- verifies GPG's `VALIDSIG` signer provenance and always removes the temporary keyring

### `scripts/build/clean-build-artifacts.mjs`

Responsibilities:

- clears stale build/caches from root and all workspaces
- keeps cleanup centralized, deterministic, and cross-platform

## Frontend TS Config Sync

`frontend/package.json` build script is:

```sh
svelte-kit sync && vite build
```

Reason:

- frontend `tsconfig.json` extends `.svelte-kit/tsconfig.json`
- `yarn clean:build` removes `.svelte-kit`
- running `svelte-kit sync` before `vite build` prevents transient missing-base-tsconfig warnings on clean builds

## Runtime Artifact Layout

Produced runtime artifacts:

- `backend/dist-desktop/server.mjs`
- `indexer/dist-desktop/scheduler-worker.mjs`
- `indexer/dist-desktop/sync-worker.mjs`
- `indexer/dist-desktop/reorg-worker.mjs`
- `indexer/dist-desktop/domain-worker.mjs`
- `indexer/dist-desktop/bootstrap-worker.mjs`
- `indexer/dist-desktop/collection-extension-worker.mjs`
- `indexer/dist-desktop/offchain-ingest-worker.mjs`
- `indexer/dist-desktop/opensea-stream-worker.mjs`
- `indexer/dist-desktop/opensea-bootstrap-worker.mjs`
- `indexer/dist-desktop/opensea-reconcile-worker.mjs`
- `indexer/dist-desktop/opensea-reconcile-scheduler-worker.mjs`
- `indexer/dist-desktop/dead-letter-worker.mjs`
- `trading/dist-desktop/bidding-bot-runtime.mjs`
- `trading/dist-desktop/sniping-bot-runtime.mjs`

During Tauri build these artifacts are copied to `src-tauri/resources/runtime/...` and that staged tree is bundled into the desktop app resources.

Produced sidecar artifacts:

- `src-tauri/binaries/artgod-secret-prompt-<target-triple>(.exe)`
- `src-tauri/binaries/artgod-secret-prompt-universal-apple-darwin` for macOS universal release builds

During Tauri build the sidecar is bundled through `bundle.externalBin` and invoked only from Rust through Tauri's `ShellExt` sidecar mechanism. The shell plugin remains initialized for that native adapter, while WebView capabilities grant no `shell:*` process permission.

### Wallet Recipient Integrity

Release builds embed SHA-256 hashes for the exact code and dependency file set
that can execute inside a key-bearing bot process:

- bundled Node under `runtime/node`
- wallet-bound artifacts, chunks, and the isolated SQLite dependency tree under `runtime/trading`

`src-tauri/build/runtime_integrity.rs` generates the Rust manifest after the
resources are staged and, on macOS, after nested Mach-O signing. The manifest
is compiled into the desktop executable rather than trusted from a mutable
sidecar file. A build-time snapshot of the same protected paths and hashes is
written beside the release executable only for package verification; runtime
authorization continues to trust the compiled manifest.

Before an unlock prompt opens, release runtime validation rejects missing,
modified, added, unpinned, or symbolic-link entries anywhere in that protected
closure. The exact Node executable, both loaders, and selected bot artifact
must also appear in the embedded manifest. Debug builds keep the same fixed
bundled paths but skip release hashing so staged resources can be rebuilt during
development.

File-set failures keep the Admin message generic while desktop-app logs report
deterministic missing and unexpected counts plus a bounded list of escaped
relative paths. Absolute install paths, hashes, environment values, and file
contents are not included in that diagnostic.

## Desktop Runtime Config Store

Desktop configuration is Admin-managed in app-data. The Rust app creates config/log directories during setup, but it does not create a runnable `.env` or start the supervisor until the operator chooses a launch path in Admin UI.

Versioned Admin settings file:

- Linux: `~/.local/share/network.artgod.desktop/config/settings.json`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/settings.json`
- Windows: `%APPDATA%\network.artgod.desktop\config\settings.json`

Rendered runtime env file:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\network.artgod.desktop\config\.env`

The settings manifest at `config/settings.manifest.toml` is the embedded Admin schema/default source. The settings file stores only operator overrides plus desktop metadata; it is not a full default snapshot. The rendered `.env` remains the startup contract for backend/indexer/trading child processes and is regenerated from effective manifest defaults plus overrides when Admin defaults are applied or configuration is saved. A stale `.env` without `settings.json` is not treated as configured and cannot drive supervisor auto-start. See `docs/desktop/04-settings-manifest-process.md` for the manifest generation and drift-control process.

Desktop-specific required keys:

- `DESKTOP_AUTO_START` (rendered from the Admin `autostart infra` checkbox)
- `DESKTOP_RESTART_BACKOFF_MS`
- `USERLAND_UI_DIST_DIR`

Desktop executable resources are not operator configuration:

- Node, NATS, runtime artifacts, and their package-local dependencies resolve
  only from the canonical `runtime` directory bundled by Tauri.
- Admin settings and the rendered `.env` cannot override executable or
  runtime-resource paths.
- Installed desktop listener ownership is Rust-side and fail-closed. Both
  `BACKEND_HOST` and the host in `NATS_URL` must be the numeric IPv4 loopback
  address `127.0.0.1`; hostnames, IPv6, wildcard, LAN, and public addresses are
  rejected before child-process startup. Rust rewrites both child values to
  their canonical loopback form.
- JetStream storage is not left to the NATS default temp path. The desktop
  supervisor always passes `--addr 127.0.0.1` and starts bundled NATS with its
  store root at `<app-data>/nats`; JetStream files live under the NATS-created
  `jetstream` child.

Userland link settings:

- `BLOCK_EXPLORER_BASE_URL` controls the explorer origin used by lookup links.
- `BLOCK_EXPLORER_TX_PATH_TEMPLATE`, `BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE`, and `BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE` control transaction, address, and block lookup paths.

Desktop-specific wallet/bot keys:

- `DESKTOP_WALLET_STORE_DIR` (defaults to `wallets`, resolved relative to app-data dir unless absolute)
- `DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS` (required; core runtime must remain healthy for this long before a bot unlock prompt is shown)

Trading bot runtime keys:

- `OPENSEA_STREAM_SECRET_KEY` (bot stream lane; separate from indexer `OPENSEA_API_KEY`)
- `OPENSEA_BIDDING_SECRET_KEY` (bot order placement/cancellation lane)
- `OPENSEA_SNAPSHOT_SECRET_KEY` (bot collection-offer snapshot polling lane)
- `BIDDING_WETH_ALLOWANCE_ETH` (exact startup WETH approval target for the OpenSea conduit, in Ether units; `0` forces no allowance and revokes any existing approval). Rust freezes it into the native-reviewed start mandate.
- `BIDDING_WETH_APPROVAL_MAX_GAS_FEE_ETH`, `BIDDING_TX_MIN_PRIORITY_FEE_GWEI`, `BIDDING_TX_MAX_FEE_GWEI`, and `BIDDING_TX_PENDING_NONCE_POLICY` are likewise frozen into the mandate as the WETH-approval fee and nonce authority.
- `BIDDING_TX_FEE_HISTORY_BLOCKS`, `BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE`, and `BIDDING_TX_BASE_FEE_MULTIPLIER` remain estimator tuning; they cannot exceed the mandate's per-gas and total-fee caps.
- `BIDDING_COMMAND_POLL_MS`, `BIDDING_COMMAND_BATCH_SIZE`, `BIDDING_COMMAND_MAX_ATTEMPTS`, and `BIDDING_COMMAND_CLAIM_TIMEOUT_MS` (DB Outbox recovery scan and retry policy for live job reconciliation)
- `BIDDING_BID_BOOK_*` and `BIDDING_RUNTIME_HEARTBEAT_*` (bot snapshot projection, backend source freshness, UI bid-book live-refresh cadence, and bot heartbeat liveness)
- `BIDDING_*` tuning keys for dry-run mode, poll intervals, bootstrap concurrency, offer expiration, snapshot cadence, and trait-refresh maps

OpenSea capability keys:

- `OPENSEA_INTEGRATION_MODE=auto|enabled|disabled` controls whether OpenSea indexer workers and OpenSea-dependent bot starts are allowed.
- `OPENSEA_API_KEY` enables OpenSea integration in `auto` mode. In `enabled` mode it is mandatory and missing config fails desktop runtime startup.
- With `auto` and no `OPENSEA_API_KEY`, desktop startup continues; the supervisor skips OpenSea indexer workers, backend/userland report OpenSea disabled, and Admin bots show the disabled reason instead of starting.
- Bidding additionally requires `OPENSEA_STREAM_SECRET_KEY`, `OPENSEA_BIDDING_SECRET_KEY`, `OPENSEA_SNAPSHOT_SECRET_KEY`, and `BIDDING_ENABLED=true`.

Core runtime keys are also validated (for backend/indexer startup), for example:

- `ARTGOD_DB_PATH`
- `BACKEND_HOST` (must be exactly `127.0.0.1` for installed desktop runtime)
- `USERLAND_UI_DIST_DIR`
- `RPC_URL_LIST` (JSON array of weighted HTTP JSON-RPC endpoints)
- `NATS_URL` (must use `nats://127.0.0.1:<port>`; `localhost`, IPv6, and non-loopback hosts are rejected)
- `WETH_ADDRESS`
- `SEAPORT_CONDUIT_CONTROLLER`
- metrics/APM exporter settings are local/deploy-only and are not rendered into the desktop Admin manifest; desktop artifacts use compile-time no-op adapters

Desktop-first default path behavior:

- `ARTGOD_DB_PATH` defaults to `sqlite/main/db` and is resolved relative to app-data dir unless absolute.
- `USERLAND_UI_DIST_DIR` defaults to `frontend/userland` and is resolved relative to desktop runtime resources dir unless absolute.
- bidding jobs are loaded from the ArtGod SQLite database.
- bidding bot heartbeat is written to SQLite as non-secret runtime state so backend reads can expose bot lifecycle independently from choosing the bot snapshot or indexed-orders bid-book feed.

Important:

- if `settings.json` has no override for a current manifest key, `.env` rendering uses the manifest default for that key without rewriting the settings file during startup
- resetting defaults clears stored overrides instead of writing all manifest defaults into `settings.json`
- desktop runtime sets `ARTGOD_ENV_FILE` for child processes, so backend/indexer read this desktop config path explicitly
- runtime artifact paths are resolved from bundled app resources, not from a workspace root path

Startup-critical config remains env-file based at the child-process boundary. Do not move supervisor bootstrap config into the main SQLite database until Rust-owned startup and TS migrations have a shared ordering contract; the backend/indexer still own DB migrations. The Admin settings JSON is Rust-owned app-data, and the rendered `.env` must stay sufficient to start NATS, backend, indexer, and userland.

## Supervisor Runtime Composition

Runtime composition code lives in:

- `src-tauri/src/runtime/config.rs`
- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/src/lib.rs`

Startup trigger:

1. Rust app setup initializes commands and logs startup, but does **not** auto-start supervisor work in `setup()`.
2. Frontend lifecycle orchestrator (`runtime/lifecycle/orchestrator.ts`) waits for Tauri bridge and invokes `runtime_auto_start`.
3. `runtime_auto_start` calls `RuntimeManager::auto_start`, which checks Admin configuration state.
4. If no settings exist, or if `autostart infra` is disabled, runtime remains cleanly `stopped` and the Admin header action sequence guides `config` -> `start infra` -> `enter the userland`.
5. If `autostart infra` is enabled, Rust renders/loads the desktop `.env`, validates runtime config, and starts the supervisor thread.

Supervisor startup order:

1. start bundled NATS process (`nats-server`) with an explicit
   `--addr 127.0.0.1` client-listener bind
2. wait for NATS port readiness
3. start backend artifact
4. wait for backend port readiness
5. start enabled indexer worker artifacts; OpenSea workers are skipped when the resolved OpenSea capability is disabled
6. wait for backend semantic readiness via `GET /health/runtime`
   : checks backend process + DB ping + NATS/JetStream jobs stream readiness details
   : NATS connectivity errors are fatal; "jobs stream not yet created" is reported as warning (`warn`) and does not block startup
7. only after semantic readiness succeeds, supervisor sets runtime status to `running`

Wallet-bound bot runtimes are not part of the startup order above.
They stay independently managed and start only after explicit admin action,
dependency stabilization, native policy review/unlock, and one exact framed
stdin secret handoff. Desktop composition shares one prompt coordinator across
wallet import, export, remove, and bot unlock operations, so only one native
wallet prompt may be active.
For bidding, Admin proposes collection ids and caps, Rust re-resolves each id through the canonical backend collection read model, and the native prompt reviews the exact identity and caps that enter the bot's immutable mandate.
During long bidder warmup, bots move from `starting` to `bootstrapping`; the supervisor treats that as a live runtime phase and expects periodic bootstrap progress before final `running`.

Each bot start reserves a monotonic lifecycle generation before dependency
waiting, prompt, decrypt, or process spawn. After prompt completion and again
after decrypt, Rust revalidates the exact launch config, wallet assignment,
canonical bidding authorization, core generation, and critical dependencies.
The controller is published under that generation before a worker barrier lets
the bot consume wallet material; worker state updates and cleanup are accepted
only from the matching generation.

If any step fails:

- already-started processes are stopped
- runtime enters restart flow with backoff
- stop requests interrupt startup waits immediately (port waits, semantic health waits, and backoff sleeps)

Frontend readiness behavior:

- admin shell is shown immediately on app mount (native WebView), with no tab active by default
- system tab exposes the lifecycle stream while the header action sequence remains the primary launch path
- lifecycle reaches `ready` only after lifecycle orchestrator backend readiness probe succeeds, not merely when runtime status becomes `running`
- admin UI does not execute userland collection/token route loads
- userland browser UI uses `backend-api.ts` directly against backend localhost origin (`/api/*`)
- runtime readiness in lifecycle orchestrator is event-first (`runtime-state-changed`) with a status reconciliation fallback poll during boot
- userland product UI is served by backend static hosting at `backend_http_base_url` and opened in system browser via admin UI/tray action

## Process Start Details

Node artifacts are launched directly. External native packages resolve through
the isolated `node_modules` directory beside each backend, indexer, or trading
artifact group; no Yarn loader executes in the installed application.
Before the backend is spawned, Rust requires and canonicalizes its
`BACKEND_HOST` to `127.0.0.1`; the backend cannot widen its installed-desktop
socket through Admin configuration.

Wallet-bound bot starts resolve the Node executable, exact trading artifact,
and configured child-process values into one immutable launch snapshot before
the native unlock prompt opens. Saving Admin configuration while the prompt is
open cannot redirect the process that receives the decrypted-key envelope.

The wallet-bound Node command clears the parent process environment before it
applies that frozen, Rust-resolved ArtGod map. Ambient launcher values such as
Node startup options or dynamic-loader controls therefore cannot execute code
in the key-bearing process before the stdin envelope is consumed.
The fixed Node arguments place `--disable-sigusr1` exactly once before the
trading artifact, so `SIGUSR1` cannot open a debugging session in the
key-bearing process.

`src-tauri/crates/artgod-sensitive-process` owns sensitive-process startup and
child containment. At Tauri-core and native-prompt startup, Unix lowers both
the soft and hard `RLIMIT_CORE` values to zero. Linux additionally sets and
verifies `PR_SET_DUMPABLE=0`; Windows enables the supported WER no-heap flag
and verifies it before secret handling. A supported-platform failure stops the
Rust process before wallet services or prompt input can proceed.

The supervisor prepares parent-death containment before spawn and attaches any
post-spawn platform resource before it writes wallet material. Linux installs
`PR_SET_PDEATHSIG(SIGKILL)` and rechecks the expected parent PID; Windows uses a
non-inheritable kill-on-close Job Object. Every platform also retains the bot's
stdin writer after the single frame as a parent-liveness lease. The Node runtime
parses the declared frame length without waiting for EOF and exits if the pipe
later closes, errors, or carries extra data.

Sensitive Unix child preparation repeats the zero core limit immediately before
`exec`, so the key-bearing Node process inherits soft and hard core limits of
zero. Linux resets process dumpability across ordinary `exec`, so the Rust
pre-exec hook does not claim to make Node nondumpable. Strong post-exec Node
nondumpability would require a separately reviewed pinned native bootstrap;
that remains deferred under the accepted same-user memory and full-host
exclusions. ArtGod does not use `LD_PRELOAD`, host sysctls, shell limits, or
global user configuration for this boundary.

The secret-frame write runs in a bounded handoff task while the supervisor
retains the child handle. Stop, core invalidation, recipient exit, or handoff
timeout force-stops the child, closing the pipe so Rust can join the writer and
zeroize its envelope before the bot worker returns.

Native wallet prompts use the same containment preparation before spawn and
attachment before request bytes. One process owner runs the bounded request
writer and bounded stdout/stderr readers, retains stdin after flush as the
portable desktop-liveness lease, and kills, reaps, and joins all I/O work on
cancellation, timeout, protocol failure, app exit, or dropped prompt work. The
helper watches that same stdin after its exact newline-delimited request; EOF or
read error closes the native window without a success response, while later
bytes fail the protocol. Forced export-reveal closure scrubs the private-key UI
state before the window is destroyed.

## Shutdown and Restart Semantics

### Trigger Paths

Desktop stop is triggered by:

- explicit command (`runtime_stop`)
- tray `shutdown` menu item
- app `ExitRequested` event hook

Window close behavior:

- `CloseRequested` is prevented
- admin window is hidden
- runtime continues in background under tray control

### Stop Strategy

Supervisor stop behavior:

1. request graceful process stop (SIGTERM on Unix)
2. wait up to grace timeout (`10s`)
3. force kill remaining processes if still running
4. join output threads
5. run cleanup hooks

Bot Stop is also valid before a process exists. It cancels a pending prompt or
start generation, waits for in-flight decrypt/start work to unwind, then
excludes stale controller publication and stale status cleanup before returning.
If the spawned recipient does not read stdin, Stop terminates it and joins the
blocked secret writer instead of waiting for pipe capacity.

Admin/tray shutdown and `ExitRequested` cancel the composition-owned prompt
controller before runtime shutdown waits begin. Prompt task drop has the same
kill/reap/join boundary. Bot Stop remains an additional cancellation source only
for the unlock prompt owned by that bot generation.

### Restart Strategy

Core composition is fail-fast:

- if any core process exits unexpectedly, supervisor stops all and restarts the full stack
- status and last error are emitted to frontend via runtime events

Wallet-bound bot runtimes use separate restart semantics:

- a bot crash does not restart the core composition
- a bot stops if one of its declared critical dependencies becomes unhealthy
- a bot restart always returns to a locked state and requires a fresh native unlock prompt
- a hard desktop-parent death closes the portable liveness lease; Linux also
  delivers the configured parent-death signal and Windows closes the retained
  kill-on-close Job Object

## Logging

Supervisor captures stdout/stderr from each child process and writes:

- `<app-data>/logs/<process>-YYYY-MM-DD.log`

The desktop app provisions expected current-day runtime log files when the
app-data log directory is initialized and during periodic log maintenance.
Provisioning is create-if-missing only; it does not truncate existing user logs.
This lets Alloy attach to staged-but-not-yet-started wallet-bound bot log files
before the operator unlocks and starts the bot, including after UTC date rollover
during long-running app sessions.

Log files are JSON Lines. When backend/indexer/trading runtimes emit structured
JSON, the supervisor keeps the JSON payload at the start of the line and adds
bounded `process` and `stream` fields. It must not prepend text such as
`[stdout]` before JSON payloads because Alloy/Loki JSON parsing depends on the
first byte of each structured log line being `{`. Non-JSON child output is
wrapped in a small JSON envelope with `t`, `level`, `component`, `action`,
`process`, `stream`, and `msg`.

Desktop log files rotate by UTC day. App and supervisor log writes resolve the
current daily target on each append, so a long-running app naturally moves from
`<process>-2026-06-01.log` to `<process>-2026-06-02.log` at the UTC date
boundary. `DESKTOP_LOG_RETENTION_HOURS` controls retention for all app-data log
files and defaults to `48`, which keeps the current UTC day plus the previous UTC
day. A value of `24` keeps only the current UTC day; `72` keeps the current day
plus the previous two days. The desktop app runs periodic staging and cleanup
while it is open and also cleans up immediately after Admin config save/default
reset, so retention changes apply without requiring app relaunch.

## Runtime Operations UI

Desktop UI is split into:

- admin UI (native Tauri WebView)
- userland UI (regular browser tab at backend localhost origin)

Admin UI mounts a dedicated shell in root layout (`frontend/src/routes/+layout.svelte`):

- shell tabs: `system`, `wallets`, `bots`
- header action sequence: `config` -> `start infra` -> `enter the userland`
- secondary header actions: `logs`, `stop infra`, `shutdown`
- Admin configuration controls: edit manifest-backed runtime settings grouped by topic, render `.env`, and toggle `autostart infra`
- live runtime state (`runtime-state-changed` event)
- logs folder opener: opens the app-data logs directory in the native file browser
- wallet metadata controls: import / export / remove
- bot controls: list / assign wallet / start / stop

Admin lifecycle UX is embedded in the `system` tab:

- available from the `system` tab while lifecycle phase is not `ready`
- shows lifecycle events as single-line rows with bracket tokens (`[level] [code]`) for copy-friendly logs
- remains in admin UI after startup as historical lifecycle stream

Tauri commands used by desktop frontend runtime UI/state:

- `app_config_get`
- `app_config_save`
- `app_config_use_defaults`
- `runtime_auto_start` (boot lifecycle orchestrator startup handshake)
- `runtime_start`
- `runtime_stop`
- `runtime_shutdown`
- `runtime_restart`
- `runtime_status`
- `runtime_preflight`
- `runtime_get_endpoints`
- `runtime_get_config_path`
- `runtime_get_logs_path`
- `runtime_get_logs_tail`
- `runtime_list_log_processes`
- `runtime_open_config_path`
- `runtime_open_logs_path`
- `runtime_open_userland_ui`
- `wallet_list`
- `wallet_get_status`
- `wallet_import`
- `wallet_export`
- `wallet_remove`
- `bot_list`
- `bot_list_bidding_collections`
- `bot_assign_wallet`
- `bot_start`
- `bot_stop`

## CI Release Pipeline

Public release workflow:

- `.github/workflows/tauri-build-check.yml` (no-bundle Linux check)
- `.github/workflows/tauri-release.yml`
- `.github/workflows/tauri-repro-check.yml` (unsigned Linux reproducibility parity check)

Trigger:

- build check: pull request, push to `main`, or manual dispatch
- release: push tag `v*`
- reproducibility check: push tag `v*` or manual dispatch

Release metadata:

- A shipped tag must exactly equal `v<root-package-version>`, such as
  `v0.0.1-pre-alpha.63` or `v1.0.0`. It publishes as a normal GitHub release
  and is marked Latest.
- A dry-run tag appends `-test.N` to the exact shipped tag, where `N` is a
  positive integer, such as `v0.0.1-pre-alpha.63-test.1`. It publishes as a
  GitHub pre-release and is not marked Latest.
- Release admission rejects version drift, lightweight or non-OpenPGP tags,
  signatures GitHub does not verify, tag/event/checkout commit mismatches, and
  commits outside `origin/main`.

Build-check trigger policy:

- The build check runs the no-write project version contract before package
  installation, so version drift fails on pull requests and `main`.
- Its required macOS job runs the real universal `better-sqlite3` node-gyp and
  `lipo` path, so both slices are proven before a release tag.
- Do not add `paths-ignore` for version-sync files; they are build-critical
  inputs for Tauri, Cargo, and workspace packaging.
- For a version-only `yarn sync:version` commit after a green merge commit on
  `main`, use GitHub's `skip-checks: true` commit trailer only when no other
  files changed.

Build matrix:

- Linux x64 (`x86_64-unknown-linux-gnu`)
- macOS Universal 2 package (`universal-apple-darwin`)
- mounted-DMG execution on `macos-15` arm64 and `macos-15-intel` x64; GitHub
  publishes the architecture behind each label in its
  [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

Outputs:

- bundle artifacts uploaded to GitHub Release
- `SHA256SUMS.txt`
- `SHA256SUMS.txt.asc`
- `artgod-release-public.asc`
- Linux detached signatures (`*.AppImage.asc`, `*.deb.asc`)
- build provenance attestation

Current state:

- Yarn package lifecycle scripts stay disabled in CI. After
  `yarn install --immutable`, the target-aware Tauri `beforeBuildCommand` runs
  `yarn build:sqlite-native --if-needed` for the allowlisted `better-sqlite3`
  native binding before runtime resources are staged. Reuse requires matching
  package and Node build metadata as well as the requested architecture.
- Tauri builds use the desktop artifact profile and fail if an observability
  exporter enters the compiled graph or if full-profile artifacts reach
  staging. The full `yarn build:runtime` profile remains available to local
  and deploy runtimes.
- Desktop staging contains only reviewed package-local SQLite/Sharp dependency
  closures; project PnP hooks, the workspace Yarn cache/install state, and
  unrelated production/development packages are absent. Universal macOS
  staging includes the fat SQLite binding and the two official Darwin
  Sharp/libvips package pairs.
- The existing single no-bundle/build invocation is followed by staged native
  dependency verification and a complete comparison of its actual adjacent
  runtime output. Linux release builds additionally extract the finished
  AppImage and `.deb`, compare the complete runtime file set, executable modes, and SHA-256
  bytes, and bind the protected closure back to the build-time copy of Rust's
  embedded integrity authority.
- The macOS application shell, Node, NATS, native secret prompt, and staged
  `better-sqlite3` add-ons are fat `x86_64` + `arm64` binaries. Backend and
  indexer stage both official Darwin Sharp/libvips pairs. Release gates mount
  the same DMG and execute the bundled runtime's SQLite and Sharp smoke
  operations on `macos-15` arm64 and `macos-15-intel` x64.
- The mounted macOS verifier requires the app's `LSMinimumSystemVersion` to
  match Tauri's configured minimum. It inspects every architecture slice's
  `LC_BUILD_VERSION` or legacy `LC_VERSION_MIN_MACOSX` command and rejects a
  deployment target above that minimum. This proves each slice declares a
  compatible deployment target; it does not replace clean-machine runtime QA
  on the oldest supported macOS.
- Linux build checks and Linux/macOS release builds launch the built Node bot
  through the production command, containment, retained-stdin, and secret-frame
  path. The proof first requires clean `SIGTERM` exit while the parent still
  owns the liveness writer, then hard-kills a nested desktop-parent harness
  after `bot_ready` and requires that exact bot PID to disappear. A separate
  containment-primitive test requires heartbeat activity to stop after its
  parent is hard-killed.
- Linux build checks, a required ordinary macOS job, and Linux/macOS release
  builds run the prompt parent-containment gate. It covers every prompt action,
  blocked request writing, bounded output, timeout, cancellation/response
  races, task drop, app-exit cleanup, stdin owner loss, and export-reveal hard
  parent death before packaging.
- Sensitive-process and parent-death gates run before no-bundle or release
  packaging. They also cover the retired prompt-response inputs, isolated
  current-process/core-limit controls, sensitive-child inheritance, fixed Node
  arguments, pinned-Node `SIGUSR1` behavior, the frozen environment, and the bot
  parent-death proofs.
- The ordinary Linux build check runs the focused runtime-output reconciliation
  test before its single no-bundle build. The test removes an obsolete runtime
  tree while proving unrelated profile output survives.
- The ordinary build workflow compiles the Windows WER no-heap and Job Object
  paths, including the prompt owner, on a Windows runner. That lane is
  compile-only; Windows release artifacts and an executed Windows prompt/bot
  containment proof remain deferred.
- Linux artifacts are GPG-signed (detached armor signatures).
- Final release assembly re-verifies downloaded AppImage and `.deb` signatures
  before signing the checksum manifest.
- The macOS app is code-signed, notarized, stapled, and distributed in one DMG.
  Before submission, the build lane verifies the fat-binary inventory, the
  final bundled Node JIT entitlement, and SQLite/Sharp native dependency smoke
  operations from the mounted DMG on its macOS runner. Final release acceptance
  repeats that mounted-DMG verification on both required macOS runner
  architectures.
  The workflow preserves the exact submitted DMG and Apple submission state
  before bounded polling, so delayed submissions can be resumed from the
  original release tag without rebuilding or resubmitting.
- Every external Action is pinned to a full commit SHA, checkout credentials are
  not persisted, and write/OIDC permissions exist only in the publication job.
- Release assembly holds the Linux signing secret but has read-only repository
  permissions. A separate secret-free job attests the finished bundles before
  publishing the GitHub Release.
- The publication job stages every asset on a draft release, captures the
  draft's numeric GitHub release ID, validates that exact draft, and publishes
  it by ID. It never rediscovers the release by tag, so release immutability
  cannot lock a duplicate or partially uploaded stable or test release.
- macOS `.p12`, keychain, and `.p8` material are removed before any later
  artifact Action can observe the corresponding runner filesystem state.
- Windows release builds are deferred for the first public alpha. When Windows
  releases are enabled later, signing should use SSL.com eSigner CKA with
  `signtool.exe` on the Windows runner.

Release secrets expected by CI:

Store release signing and notarization secrets as GitHub Environment secrets in
`desktop-release-signing`, not as repository-wide secrets. The release workflow
declares that environment on protected release jobs, but secrets are passed only
to the exact steps that consume them. The build-check and reproducibility
workflows do not use signing secrets.

- Linux GPG:
    - `LINUX_GPG_PRIVATE_KEY_ASC`
    - `LINUX_GPG_PASSPHRASE`
    - `LINUX_GPG_KEY_ID`
    - optional: `LINUX_GPG_OWNERTRUST`
      Detailed key-generation, subkey, rotation, and compromise-response guidance
      is in `docs/desktop/05-linux-gpg-release-signing.md`.
- macOS:
    - `APPLE_CERTIFICATE` (base64 `.p12`)
    - `APPLE_CERTIFICATE_PASSWORD`
    - `APPLE_SIGNING_IDENTITY`
    - `APPLE_API_KEY_P8_B64` (base64 `.p8`)
    - `APPLE_API_KEY_ID`
    - `APPLE_API_ISSUER`

Windows maintainer-profile note:

- The release-signing runbook treats SSL.com Personal Identity Code Signing
  with eSigner for Code as the future Windows path.
- The alpha release workflow does not build Windows artifacts.

Consumer-side verification:

```sh
gpg --show-keys --with-fingerprint --with-subkey-fingerprint artgod-release-public.asc
gpg --import artgod-release-public.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum --ignore-missing --check SHA256SUMS.txt
gpg --verify "<linux-bundle>.asc" "<linux-bundle>"
gh attestation verify "<bundle>" -R d347h-eth/artgod
```

The root README publishes the expected primary and signing-subkey fingerprints
and owns the concise consumer flow. The signed checksum manifest covers the
macOS DMG; Gatekeeper separately evaluates its Developer ID signature and
stapled Apple notarization ticket.

## Troubleshooting

Common issues and checks:

- Runtime artifacts missing
  : Run `yarn install --immutable && yarn build:sqlite-native && yarn build:desktop-runtime && yarn build:desktop-runtime-resources`.

- Stale dist/cache state
  : Run `yarn clean:build`.

- Repeated local no-bundle QA
  : Use `yarn build:desktop:no-bundle`. The build automatically replaces only
  Tauri's copied runtime tree, so `clean:build` is unnecessary unless broader
  generated state is damaged.
  : Run `yarn check:desktop-no-bundle-runtime` after a debug no-bundle build when
  you want the same exact-copy proof used by CI.

- Desktop config key errors on startup
  : Check Admin `config`, app-data `settings.json`, the rendered `.env`, and required `DESKTOP_*` keys.

- Port already in use after abrupt stop
  : Current supervisor includes graceful stop + forced cleanup; if interrupted externally, verify no stale `nats-server`/runtime process remains before restart.

- Startup request reaches terminal API failure (`api.request.fail.final`)
  : Current boot flow does not include an automatic background recovery probe. If dependencies recover after terminal failure, trigger a manual reload/restart to resume normal route loading.
