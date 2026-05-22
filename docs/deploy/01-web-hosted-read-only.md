# Web-Hosted Read-Only Instance

This document describes the current hosted deployment for a public, read-only ArtGod instance.

Today that public mode is intended for a single fixed collection deployment:

- `terraforms.artgod.network/` -> Terraforms tokens
- `terraforms.artgod.network/activity` -> Terraforms activities
- `terraforms.artgod.network/holders` -> Terraforms holders
- `terraforms.artgod.network/holders/:owner_ref` -> Terraforms owner tokens
- `terraforms.artgod.network/:token_ref` -> Terraforms token detail

## Shape

- By default, the ArtGod deploy stack is prepared to sit behind an already-running VPS-wide Caddy or other reverse proxy.
- The deploy compose also includes an optional bundled Caddy service behind the `bundled-caddy` compose profile.
- The browser-facing UI is the SSR web frontend (`frontend/build-web`).
- The backend API is a separate service.
- NATS and all indexer workers run alongside them in Docker.

The deploy compose intentionally keeps public writes/admin surfaces disabled by route registration:

- backend runs in `public_single_collection` mode
- only Terraforms read routes are registered publicly
- bootstrap and customization routes are not registered
- collection-list routes are not registered
- CSRF issuance route is not registered

This is the intended mode for a public browse-only instance that you administer manually under the hood.

## Files

- `docker-compose.deploy.yml`
- `Dockerfile.deploy`
- `Caddyfile.deploy`
- `.env.deploy.example`

## Shared Docker Edge Network

To let an existing Caddy container from another compose project reach ArtGod directly by container DNS name, create a shared external Docker network once on the VPS:

```sh
docker network create public-edge
```

ArtGod joins that network with stable aliases:

- `artgod-backend`
- `artgod-frontend`
- `artgod-grafana` when the `observability` profile is enabled

If you want a different network name, set `PUBLIC_EDGE_NETWORK` in `.env.deploy` and use the same name from the other compose project.

## Public Routing

### Reusing an Existing VPS Caddy

If you already have a Caddy container running from another compose project, connect that Caddy service to the same external network and route:

- `/api/*` and `/health/*` -> `artgod-backend:3000`
- everything else -> `artgod-frontend:4173`

Example Caddy site block:

```caddy
terraforms.artgod.network {
  encode zstd gzip

  @backend path /api/* /health/*
  reverse_proxy @backend artgod-backend:3000

  reverse_proxy artgod-frontend:4173
}
```

For an observability subdomain, route that site to Grafana inside the same Docker edge network:

```caddy
observability.artgod.network {
  encode zstd gzip
  reverse_proxy artgod-grafana:3000
}
```

Note that the SSR frontend itself should not call the backend through the public site origin during server-side rendering. In deploy mode it uses a separate internal origin (`INTERNAL_BACKEND_ORIGIN`, default `http://backend:3000`) so SSR requests go straight to the backend container instead of being treated as same-origin internal frontend requests.

### Optional Bundled Caddy

The bundled Caddy service exposes:

- `http://:80`
- `https://:443`

Its routing is:

- `/api/*` and `/health/*` -> `backend:3000`
- everything else -> `frontend-web:4173`

ArtGod `backend` and `frontend-web` are not published to host ports by default. They are reachable only on the Docker networks (`default` and the shared `public-edge` network), which avoids host-port conflicts with other stacks on the VPS.

`nats` is also internal-only and not published to the host.

## DNS And Firewall

Before starting the stack:

- point `PUBLIC_SITE_HOST` (for example `terraforms.artgod.network`) at the VPS with an `A` / `AAAA` record
- open inbound `80/tcp`, `443/tcp`, and `443/udp`
- make `PUBLIC_BACKEND_ORIGIN` match the same public site origin, e.g. `https://terraforms.artgod.network`
- create the shared Docker edge network before starting the stack

## Build And Start

1. Copy the deploy env template:

```sh
cp .env.deploy.example .env.deploy
```

2. Fill the required values in `.env.deploy`:

- `PUBLIC_SITE_HOST`
- `PUBLIC_BACKEND_ORIGIN`
- `INTERNAL_BACKEND_ORIGIN=http://backend:3000`
- `PUBLIC_EDGE_NETWORK=public-edge`
- `PUBLIC_APP_DEPLOYMENT_MODE=public_single_collection`
- `PUBLIC_APP_CHAIN_REF=ethereum`
- `PUBLIC_APP_COLLECTION_REF=terraforms`
- `BACKEND_QUERY_CACHE_PROVIDER=memory`
- `BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS=60000`
- `BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS=600000`
- `BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS=1200000`
- `RPC_URL`
- `OPENSEA_API_KEY`

If enabling deploy observability, also set:

- `INDEXER_METRICS_ENABLED=true`
- `BACKEND_METRICS_ENABLED=true`
- `INDEXER_APM_ENABLED=true`
- `BACKEND_APM_ENABLED=true`
- `OBSERVABILITY_OTLP_HTTP_URL=http://tempo:4318/v1/traces`
- `OBSERVABILITY_PYROSCOPE_URL=http://pyroscope:4040`
- `OBSERVABILITY_GRAFANA_ADMIN_PASSWORD` to a non-default value before routing Grafana from a public subdomain

3. Build and start the stack:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up --build -d
```

To start the same stack with Loki, Alloy, Prometheus, Tempo, Pyroscope, and Grafana:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml --profile observability up --build -d
```

If you want to use the bundled Caddy instead of an existing VPS proxy:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml --profile bundled-caddy up --build -d
```

Profiles can be combined:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml --profile bundled-caddy --profile observability up --build -d
```

If you need temporary direct host access to backend/frontend for debugging, use a one-off compose override or `docker exec`/`docker compose exec` inside the stack rather than permanent host port bindings.

4. Inspect logs:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f caddy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f backend
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f indexer-sync-worker
```

## Observability

The deploy compose defines an `observability` profile with:

- Loki for log storage.
- Alloy for Docker log discovery and forwarding to Loki.
- Prometheus scraping backend and indexer worker `/metrics` endpoints over the compose network.
- Tempo receiving OTLP HTTP traces at `http://tempo:4318/v1/traces`.
- Pyroscope receiving profiles at `http://pyroscope:4040`.
- Grafana exposed only inside `public-edge` as `artgod-grafana:3000`.

Alloy reads Docker logs through a read-only `/var/run/docker.sock` mount and keeps only containers labeled with `com.artgod.observability.logs=true`. The app, NATS, and bundled Caddy services carry that label; observability service logs are intentionally not scraped by default.

Grafana uses deploy-specific datasource provisioning under `observability/grafana/provisioning-deploy/datasources` because deploy containers talk to each other by compose service name instead of localhost.

## Manual Admin

Because public write/admin routes are not exposed in this deployment mode, do manual admin from the VPS itself at the DB/process level for now.

## Notes

- Project versioning is documented centrally in `README.md` under `Versioning`.
- The deploy stack does not take a separate app-version env override; the frontend build reads the root workspace version directly.
- `PUBLIC_BACKEND_ORIGIN` is the browser-facing backend origin baked into the SSR frontend build. If you change the public domain, rebuild the image.
- `INTERNAL_BACKEND_ORIGIN` is the runtime-only backend origin used by the SSR frontend server process itself; in the default compose setup it should stay `http://backend:3000`.
- `PUBLIC_SITE_HOST` is consumed by the optional bundled Caddy service and should match the host portion of `PUBLIC_BACKEND_ORIGIN`.
- `PUBLIC_EDGE_NETWORK` is the shared external Docker network used to reach `artgod-backend` and `artgod-frontend` from another compose project.
- When the deploy observability profile is enabled, the same shared network also exposes `artgod-grafana:3000` for a reverse proxy managed outside this compose file.
- `PUBLIC_APP_DEPLOYMENT_MODE`, `PUBLIC_APP_CHAIN_REF`, and `PUBLIC_APP_COLLECTION_REF` are also build-time inputs for the SSR frontend image, and runtime inputs for the backend service.
- `BACKEND_QUERY_CACHE_PROVIDER`, `BACKEND_PUBLIC_COLLECTION_*`, `BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS`, and `BACKEND_QUERY_CACHE_TOKEN_PREVIEW_*` are backend runtime-only env vars. They do not affect the frontend image build. Recreating only the `backend` container is enough after changing them.
- `BACKEND_QUERY_CACHE_PROVIDER=memory` enables the backend in-memory query cache for the public VPS deployment.
- `BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS` controls how often the backend refreshes the cached public collection page (`listed`, first page, no filters) in the background.
- `BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS` controls how often those background collection refreshes also trigger preview warmup for the current 250 visible tokens.
- `BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS` controls how often the backend fully rebuilds the compact public blockspace cache for the configured single collection.
- `BACKEND_QUERY_CACHE_TOKEN_PREVIEW_*` controls the preview-modal cache itself. That cache stores only default-media token previews, serves stale responses during the grace window, and refreshes them in the background when an individual preview entry goes stale.
- `INDEXER_METRICS_ENABLED=true` starts per-worker Prometheus HTTP endpoints; `BACKEND_METRICS_ENABLED=true` starts the backend API Prometheus endpoint on `BACKEND_METRICS_PORT` (`9480` by default).
- `INDEXER_METRICS_HOST=0.0.0.0` and `BACKEND_METRICS_HOST=0.0.0.0` are required so Prometheus can scrape across the compose network.
- `INDEXER_APM_ENABLED=true` starts indexer trace/profile exporters; `BACKEND_APM_ENABLED=true` starts backend API trace/profile exporters. In deploy mode `OBSERVABILITY_OTLP_HTTP_URL` and `OBSERVABILITY_PYROSCOPE_URL` must be the service-name URLs `http://tempo:4318/v1/traces` and `http://pyroscope:4040`, not localhost.
- The deploy image relies on the repo’s Yarn allowlist policy during `yarn install --immutable --inline-builds`: `enableScripts: false` stays in effect globally, while allowlisted packages such as `esbuild` are still built through `dependenciesMeta.built: true`. `better-sqlite3` is then built explicitly and narrowly by invoking its trusted package-local `install` script from inside the unplugged package directory, and the image hard-fails if the native SQLite binding is still missing from `.yarn/unplugged`.
- The deploy image reuses the same backend/indexer runtime artifacts and Yarn PnP Node launch shape as the desktop supervisor.
- SQLite is persisted in the named Docker volume mounted at `/data`.
- Bundled Caddy certificates and config state are persisted in the named Docker volumes `caddy-data` and `caddy-config`.
- Deploy observability data is persisted in the named Docker volumes `loki-data`, `tempo-data`, `pyroscope-data`, `prometheus-data`, and `grafana-data`.
