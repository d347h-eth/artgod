# Backend Documentation

The backend is a loopback-first HTTP boundary over local application use cases
and their SQLite, NATS, RPC, media, and cache adapters. It does not run indexer
ingestion workers or the wallet-bound marketplace bidding loop.

1. [API and application architecture](01-api-and-application-architecture.md)
   explains the hexagonal dependency flow, composition root, read models, and
   route registration.
2. [HTTP security and deployment modes](02-http-security-and-deployment-modes.md)
   explains loopback mutation protection, public read-only mode, cache policy,
   and trust boundaries.
3. [OpenAPI](openapi.yaml) is the machine-readable route contract. Registered
   non-wildcard methods and paths are checked against
   `backend/src/http-routes.ts` by `yarn check:docs`.

Neighboring topics:

- [Indexer](../indexer/README.md) owns the ingestion that builds materialized
  domain state.
- [Trading](../trading/README.md) owns wallet-bound bidding execution; the
  backend owns the job-management and bidding read APIs that drive it.
- [Desktop](../desktop/README.md) owns process supervision and local secret
  custody.
- [Hosted deployment](../deploy/01-web-hosted-read-only.md) owns the public
  read-only composition.
