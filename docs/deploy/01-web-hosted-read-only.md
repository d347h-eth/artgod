# Web-Hosted Read-Only Instance

This document describes the current first-pass hosted deployment for a public, read-only ArtGod instance.

## Shape

- The browser-facing UI is the SSR web frontend (`frontend/build-web`).
- The backend API is a separate service.
- NATS and all indexer workers run alongside them in Docker.
- Reverse proxy / TLS termination is expected to be handled outside this file (for example by your own Caddy setup).

The deploy compose intentionally keeps public writes disabled:

- `BACKEND_ALLOWED_HOSTS` stays loopback-only.
- `BACKEND_ALLOWED_ORIGINS` stays loopback-only.
- Public `GET` requests work through the reverse proxy.
- Public mutating requests fail backend host/origin checks.

This is the intended mode for a public browse-only instance that you administer manually under the hood.

## Files

- `docker-compose.deploy.yml`
- `Dockerfile.deploy`
- `.env.deploy.example`

## Reverse Proxy Routing

Expose a single public origin and route:

- `/api/*` and `/health/*` -> backend at `127.0.0.1:3000`
- everything else -> SSR frontend at `127.0.0.1:4173`

The compose file binds those two ports only on loopback for proxying/admin use:

- backend: `127.0.0.1:3000`
- frontend: `127.0.0.1:4173`

`nats` is internal-only and not published to the host.

## Build And Start

1. Copy the deploy env template:

```sh
cp .env.deploy.example .env.deploy
```

2. Fill the required values in `.env.deploy`:

- `PUBLIC_BACKEND_ORIGIN`
- `RPC_URL`
- `OPENSEA_API_KEY`

3. Build and start the stack:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up --build -d
```

4. Inspect logs:

```sh
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f backend
docker compose --env-file .env.deploy -f docker-compose.deploy.yml logs -f indexer-sync-worker
```

## Manual Admin

Because public write routes remain blocked, do manual admin from the VPS itself or through an SSH tunnel.

Examples:

- SSH into the VPS and call `http://127.0.0.1:3000`
- or forward locally:

```sh
ssh -L 3000:127.0.0.1:3000 <host>
```

Then use the local loopback backend origin for CSRF-protected write calls.

## Notes

- `PUBLIC_BACKEND_ORIGIN` is a build-time input for the SSR frontend image. If you change the public domain, rebuild the image.
- The deploy image reuses the same backend/indexer runtime artifacts and Yarn PnP Node launch shape as the desktop supervisor.
- SQLite is persisted in the named Docker volume mounted at `/data`.
