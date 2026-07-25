# Backend HTTP Security and Deployment Modes

The backend has two compositions with deliberately different route surfaces:

- `standard` serves the local Admin/Userland application and includes operator
  mutations;
- `public_single_collection` serves a read-only view constrained to one
  configured chain and collection.

Changing the frontend navigation alone cannot turn one mode into the other. The
backend route registry and scope guards enforce the server-side boundary.

## Standard Local Mode

Standard mode registers the full local read surface, the CSRF issuer, and Admin
mutation routes.
Every `POST`, `PUT`, `PATCH`, or `DELETE` request under `/api/` must pass all of
these checks before its handler runs:

1. the normalized `Host` header is in `BACKEND_ALLOWED_HOSTS`;
2. the normalized `Origin` header is in `BACKEND_ALLOWED_ORIGINS`;
3. the `X-ArtGod-CSRF` header is present;
4. the trimmed header token matches the `artgod_csrf` cookie.

`GET /api/security/csrf` returns the token in the response body and sets a
32-hex-character, `HttpOnly`, `SameSite=Strict`, 24-hour cookie. Set
`BACKEND_CSRF_COOKIE_SECURE=true` when the browser reaches the backend over
HTTPS.

Allowed-origin CORS responses echo only a configured origin, enable credentials,
and set `Vary: Origin`. There is no wildcard credentialed CORS policy.

## Public Single-Collection Mode

Public mode does not register the CSRF issuer or any Admin routes. Its read
surface includes health/config reads plus collection, token, activity, trait,
holder, preview, tokenURI, bid-book, owner-resolution, and blockspace reads that
are useful to the public site.

Route guards enforce:

- chain-scoped reads must match `PUBLIC_APP_CHAIN_REF`;
- collection-scoped reads must also match `PUBLIC_APP_COLLECTION_REF`;
- blockspace is fixed to the configured collection and uses its cached read
  port when the backend query-cache provider is enabled;
- private bidding context is omitted from collection and token bid-book
  responses.

The fixed collection can have an extension such as Terraforms, but the mode is
generic: it is not a Terraforms-only backend contract.

See the [hosted topology](../diagrams/08-hosted-read-only-topology.md) and
[deployment runbook](../deploy/01-web-hosted-read-only.md).

## Listener and Network Boundary

Desktop and ordinary local development bind the backend to the configured local
host and port. The desktop supervisor provisions the expected loopback
listeners; the [port catalog](../ports/01-port-catalog.md) is canonical.

In the hosted Docker composition:

- the backend and `frontend-web` listeners remain on private Compose networks;
- `frontend-web` uses the private backend origin for server-side requests;
- the public edge proxy is the browser-facing ingress;
- SQLite, NATS, indexer workers, and observability services are not public API
  endpoints.

Host/origin/CSRF checks are defense in depth, not a reason to expose standard
mode directly to an untrusted network.

## Cached Media

The backend can serve files from the configured token-image cache through a
dedicated static route. The route rejects lexical path traversal outside the
configured cache root and serves targets that filesystem metadata reports as
regular files. It currently follows symlinks during metadata and file reads, so
the cache root must not contain untrusted symlinks. The cache is derived media,
not a writable upload API.

## Observability and Sensitive Data

HTTP metrics and spans use registered route templates rather than raw URLs.
Query-cache response diagnostics may retain allowlisted query keys, but they
drop query values.
Secrets, CSRF tokens, wallet material, raw keystore passwords, and full
marketplace credentials must never be logged or added as telemetry attributes.

## What This Boundary Does Not Prove

Host/origin checks and double-submit CSRF stop common cross-site mutation paths.
They do not authenticate a local browser tab as a child of the Tauri-supervised
runtime: another local process may still be able to reach loopback and act as an
allowed browser origin. Standard mode therefore keeps wallet decryption and
private-key handling in Rust/native boundaries and passes bot secrets through a
one-shot parent channel, not through HTTP.

The staged authenticated-runtime design is documented in
[Local Runtime Trust](../desktop/07-local-runtime-trust.md) and tracked as
`BKL-052` in the [unified backlog](../planning/01-unified-backlog.md).

## Verification

Use repository-owned checks:

```sh
yarn workspace @artgod/backend test
yarn test:desktop:listener-boundaries
yarn check:docs
```

For the hosted composition, use the internal frontend probe described in the
[deployment runbook](../deploy/01-web-hosted-read-only.md); a host-side backend
`curl` is not expected when the service has no published host port.
