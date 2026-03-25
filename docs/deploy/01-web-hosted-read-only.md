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
- `RPC_URL`
- `OPENSEA_API_KEY`

3. Build and start the stack:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up --build -d
```

If you want to use the bundled Caddy instead of an existing VPS proxy:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml --profile bundled-caddy up --build -d
```

If you need temporary direct host access to backend/frontend for debugging, use a one-off compose override or `docker exec`/`docker compose exec` inside the stack rather than permanent host port bindings.

4. Inspect logs:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f caddy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f backend
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f indexer-sync-worker
```

## Manual Admin

Because public write/admin routes are not exposed in this deployment mode, do manual admin from the VPS itself at the DB/process level for now.

## Notes

- `PUBLIC_BACKEND_ORIGIN` is the browser-facing backend origin baked into the SSR frontend build. If you change the public domain, rebuild the image.
- `INTERNAL_BACKEND_ORIGIN` is the runtime-only backend origin used by the SSR frontend server process itself; in the default compose setup it should stay `http://backend:3000`.
- `PUBLIC_SITE_HOST` is consumed by the optional bundled Caddy service and should match the host portion of `PUBLIC_BACKEND_ORIGIN`.
- `PUBLIC_EDGE_NETWORK` is the shared external Docker network used to reach `artgod-backend` and `artgod-frontend` from another compose project.
- `PUBLIC_APP_DEPLOYMENT_MODE`, `PUBLIC_APP_CHAIN_REF`, and `PUBLIC_APP_COLLECTION_REF` are also build-time inputs for the SSR frontend image, and runtime inputs for the backend service.
- The deploy image relies on the repo’s Yarn allowlist policy during `yarn install --immutable --inline-builds`: `enableScripts: false` stays in effect globally, while allowlisted packages such as `esbuild` are still built through `dependenciesMeta.built: true`. `better-sqlite3` is then built explicitly and narrowly by invoking its trusted package-local `install` script from inside the unplugged package directory, and the image hard-fails if the native SQLite binding is still missing from `.yarn/unplugged`.
- The deploy image reuses the same backend/indexer runtime artifacts and Yarn PnP Node launch shape as the desktop supervisor.
- SQLite is persisted in the named Docker volume mounted at `/data`.
- Bundled Caddy certificates and config state are persisted in the named Docker volumes `caddy-data` and `caddy-config`.
