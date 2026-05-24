# Settings Manifest Process

ArtGod runtime settings are manifest-first. The canonical editable source for setting keys, labels, defaults, Admin UI metadata, and launch requirements is:

- `config/settings.manifest.toml`

Generated artifacts are committed so runtime packages and operators do not parse TOML at startup:

- `.env.example`
- `shared/config/generated-settings-defaults.ts`

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

Public web deployment still manages public-hosting-only values directly through deployment env files. Those settings remain in the manifest for `.env.example` and generated defaults, but should be marked `desktop_managed = false` when they do not belong in the desktop Admin UI or desktop-rendered `.env`.

The root manifest `default` is the local developer `.env.example` baseline.
Values that only make sense in another runtime context should stay blank at the root and be supplied by the context that owns them.
For example, hosted Docker deploy provides `INTERNAL_BACKEND_ORIGIN=http://backend:42710` through `.env.deploy.example`, while desktop provides `USERLAND_UI_DIST_DIR=frontend/userland` through `desktop_default`.

## Manifest Fields

Each setting entry must include:

- `key`: env var name.
- `group`: one of the manifest group ids.
- `label`: Admin UI label.
- `default`: root runtime default used by `.env.example` and generated TS defaults.

Optional fields:

- `desktop_default`: desktop-specific default used for Admin-rendered `.env`.
- `help`: Admin info-tip text.
- `view`: `basic` or `advanced`; absent settings default to advanced-only UI.
- `input`: `text`, `password`, `checkbox`, `textarea`, or `select`.
- `options`: allowed values for `select`.
- `validation`: currently `url` or `websocket_url`.
- `required_for_launch`: blocks `start infra` when the effective desktop value is empty or invalid.
- `desktop_managed`: set `false` for settings that are known to the app but should not be shown or rendered by desktop Admin.
- `secret`: marks sensitive settings in the Admin schema.

Backend/indexer-specific override URLs such as `BACKEND_APM_OTLP_HTTP_URL`, `BACKEND_APM_PYROSCOPE_URL`, `INDEXER_APM_OTLP_HTTP_URL`, and `INDEXER_APM_PYROSCOPE_URL` intentionally keep blank defaults. Runtime config falls back to the root `OBSERVABILITY_*` settings, so defaults stay centralized while component-specific overrides remain available.

## Change Workflow

1. Edit `config/settings.manifest.toml`.
2. If a TypeScript config module needs the default at runtime, import the generated helper from `@artgod/shared/config/generated-settings-defaults` instead of adding a literal fallback.
3. If desktop Admin needs new schema behavior, update `src-tauri/src/runtime/app_config_manifest.rs` and `src-tauri/src/runtime/app_config.rs`.
4. Run:

```sh
yarn config:generate
```

5. Commit `config/settings.manifest.toml`, `.env.example`, `shared/config/generated-settings-defaults.ts`, and any runtime consumer changes together.

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
- `.env.example` and `shared/config/generated-settings-defaults.ts` must be generated, not hand-edited.
- `yarn config:check` is the guard for stale generated settings artifacts.
- Update `docs/ports/01-port-catalog.md` when changing port defaults.
- Update operator docs when changing launch-required settings, Admin-visible grouping, validation, or desktop-only behavior.
