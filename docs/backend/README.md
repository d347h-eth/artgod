# Backend Documentation

The backend is a loopback-first HTTP adapter over local use cases and SQLite
read/write adapters. It does not own indexing or trading business behavior.

1. [API and application architecture](01-api-and-application-architecture.md)
   explains the hexagonal dependency flow, composition root, read models, and
   route registration.
2. [HTTP security and deployment modes](02-http-security-and-deployment-modes.md)
   explains loopback mutation protection, public read-only mode, cache policy,
   and trust boundaries.
3. [OpenAPI](openapi.yaml) is the machine-readable route contract. Registered
   methods and paths are checked against `backend/src/http-routes.ts` by
   `yarn check:docs`.

Neighboring topics:

- [Indexer](../indexer/README.md) owns ingestion and materialized domain state.
- [Trading](../trading/README.md) owns bidding behavior driven through backend
  use cases.
- [Desktop](../desktop/README.md) owns process supervision and local secret
  custody.
- [Hosted deployment](../deploy/01-web-hosted-read-only.md) owns the public
  read-only composition.
