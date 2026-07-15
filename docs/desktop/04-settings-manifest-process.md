# Settings Manifest Process

ArtGod runtime settings are manifest-first. The canonical editable source for setting keys, labels, defaults, Admin UI metadata, and launch requirements is:

- `config/settings.manifest.toml`

Generated artifacts are committed so runtime packages and operators do not parse TOML at startup:

- `.env.example`
- `.env.deploy.example`
- `shared/config/generated-settings-defaults.ts`
- `shared/config/generated-settings-validation-rules.ts`
- `frontend/src/lib/e2e/generated-desktop-admin-config.ts`

Do not edit generated artifacts directly. Update the manifest, run generation, and commit the manifest plus generated outputs together.

## Runtime Contract

The manifest has three consumers:

- Rust desktop Admin config loads the embedded manifest through `src-tauri/src/runtime/app_config_manifest.rs`.
- Desktop persistence in `src-tauri/src/runtime/app_config.rs` stores only operator overrides in app-data `settings.json`.
- TypeScript runtime config modules import generated defaults from `@artgod/shared/config/generated-settings-defaults`.

The desktop settings file is not a full default snapshot. If a key is missing from `settings.json`, desktop `.env` rendering uses the current manifest default without mutating `settings.json`. Resetting defaults clears overrides instead of writing every default into the settings file.

The rendered desktop `.env` remains the child-process startup contract for backend, indexer, trading, NATS, and userland. It is generated from:

```text
settings.manifest.toml defaults + settings.json overrides
```

For bidding starts, Rust freezes that rendered process config before prompting
and derives the immutable native `startPolicy` from the same snapshot. Node
requires the typed security-relevant settings to agree exactly with the
received mandate before runtime composition, then enforces the mandate as the
authority. Editing Admin settings while a generation is active affects only a
later start. Fee-history block count, reward percentile, and base-fee multiplier
remain runtime estimator tuning; offer expiration remains Config-only.

Admin-only desktop settings may still live in the manifest when they control
desktop configuration actions rather than child-process runtime behavior.
`RPC_AUTO_SOURCING_TRACKING_POLICY` is one such setting: it controls the Admin
Chainlist endpoint sourcing action, defaults to no-tracking endpoints, and is
targeted only at `desktop`.

Bundled executable-resource locations are not settings. Node, NATS, runtime
artifact paths, and package-local dependency paths are owned by the desktop
build/runtime contract and must not be exposed through this manifest or
persisted Admin overrides.

Public web deployment still manages public-hosting-only values directly through deployment env files. Those settings remain in the manifest for `.env.example` and generated defaults, but should be marked `desktop_managed = false` when they do not belong in the desktop Admin UI or desktop-rendered `.env`.

The root manifest `default` is the local developer `.env.example` baseline.
Use the nested `defaults` table when a setting needs context-specific values.
Values that only make sense in another runtime context should stay blank locally and be supplied by the context that owns them.
For example, hosted Docker deploy provides `INTERNAL_BACKEND_ORIGIN=http://backend:42710` through `defaults.deploy`, while desktop provides `USERLAND_UI_DIST_DIR=frontend/userland` through `defaults.desktop`.

## Manifest Fields

Each setting entry must include:

- `key`: env var name.
- `group`: one of the manifest group ids.
- `label`: Admin UI label.
- `default`: local default used by `.env.example` and generated TS defaults, unless `defaults.local` is set instead.

Optional fields:

- `defaults`: inline table for context-specific defaults. Supported keys are `local`, `deploy`, and `desktop`.
- `targets`: emitted contexts for the setting. Supported values are `local`, `deploy`, and `desktop`; absent settings target all three.
- `desktop_default`: desktop-specific default used for Admin-rendered `.env`.
- `help`: Admin info-tip text.
- `view`: `basic` or `advanced`; absent settings default to advanced-only UI.
- `input`: `text`, `password`, `checkbox`, `textarea`, `select`, or `weighted_endpoint_list`.
- `options`: allowed values for `select`.
- `validation`: one of the values owned by `config/settings-validation-rules.json`, including URL, positive-integer, TCP-port, RPC endpoint-list, and block-explorer rules.
- `required_for_launch`: blocks `start infra` when the effective desktop value is empty or invalid.
- `desktop_managed`: set `false` for settings that are known to the app but should not be shown or rendered by desktop Admin.
- `secret`: marks sensitive settings in the Admin schema.

For ordinary app settings, keep the short `default = "..."` form. Use `defaults = { local = "...", deploy = "...", desktop = "..." }` only when at least one context needs a different value. Use `targets = ["deploy"]` for deploy orchestration keys that should appear only in `.env.deploy.example`.

Backend/indexer-specific override URLs such as `BACKEND_APM_OTLP_HTTP_URL`,
`BACKEND_APM_PYROSCOPE_URL`, `INDEXER_APM_OTLP_HTTP_URL`, and
`INDEXER_APM_PYROSCOPE_URL` intentionally keep blank defaults. Runtime config
falls back to the root `OBSERVABILITY_*` settings, so defaults stay centralized
while component-specific overrides remain available. Backend/indexer metrics
and every APM/profile setting target only `local` and `deploy`; those groups do
not appear in Admin or its rendered `.env`.

Trading metrics are the narrow desktop exception. Admin renders
`TRADING_METRICS_ENABLED` and `TRADING_METRICS_PORT_BIDDING_BOT`, but not
`TRADING_METRICS_HOST`. Rust writes that host as `127.0.0.1` into the child
environment regardless of persisted input. The desktop artifact admits only
the reviewed trading Prometheus facade and continues to reject the full metrics
barrel, tracing, and profiling implementations.

Validation rule names are defined once in `config/settings-validation-rules.json`.
`yarn config:generate` emits the typed shared contract consumed by Admin, while
the desktop embeds the same JSON file when validating the manifest. The same
command generates `frontend/src/lib/e2e/generated-desktop-admin-config.ts`, so
the maintained browser harness renders the desktop-managed schema and defaults
from the manifest instead of maintaining a parallel fixture. Run `yarn
config:check` after generation to catch drift.

## Change Workflow

1. Edit `config/settings.manifest.toml`.
2. If a TypeScript config module needs the default at runtime, import the generated helper from `@artgod/shared/config/generated-settings-defaults` instead of adding a literal fallback.
3. If desktop Admin needs new schema behavior, update `src-tauri/src/runtime/app_config_manifest.rs` and `src-tauri/src/runtime/app_config.rs`.
4. Run:

```sh
yarn config:generate
```

5. Commit `config/settings.manifest.toml`, `.env.example`, `.env.deploy.example`,
   `shared/config/generated-settings-defaults.ts`,
   `shared/config/generated-settings-validation-rules.ts`,
   `frontend/src/lib/e2e/generated-desktop-admin-config.ts`, and any runtime
   consumer changes together. Include `config/settings-validation-rules.json`
   when the validation vocabulary changes.

## Required Checks

Run these before review when settings change:

```sh
yarn config:check
yarn tsc -b
yarn workspace @artgod/frontend check
```

Run focused runtime tests for touched consumers:

```sh
yarn workspace @artgod/backend test src/config.test.ts
yarn workspace @artgod/indexer test tests/indexer-config.test.ts tests/opensea-config.test.ts
yarn workspace @artgod/shared test
```

When backend or indexer defaults affect broader runtime behavior, also run:

```sh
ARTGOD_DB_PATH=/tmp/artgod-backend-tests.sqlite yarn workspace @artgod/backend test
ARTGOD_DB_PATH=/tmp/artgod-indexer-tests.sqlite yarn workspace @artgod/indexer test --exclude tests/smoke.test.ts
```

The full indexer smoke suite additionally requires `SMOKE_*` env values and is not covered by the temp-DB command above.

## Drift Rules

- No hardcoded fallback default should be added to backend/indexer config if the value exists in the manifest.
- `.env.example`, `.env.deploy.example`,
  `shared/config/generated-settings-defaults.ts`,
  `shared/config/generated-settings-validation-rules.ts`, and
  `frontend/src/lib/e2e/generated-desktop-admin-config.ts` must be generated,
  not hand-edited.
- `yarn config:check` is the guard for stale generated settings artifacts.
- Update `docs/ports/01-port-catalog.md` when changing port defaults.
- Update operator docs when changing launch-required settings, Admin-visible grouping, validation, or desktop-only behavior.
