# Local Runtime Trust

ArtGod runs the backend, frontend, workers, database, and broker on the user's
machine. Loopback reduces network exposure, but it does not prove which local
process owns a port or which browser session belongs to the supervised desktop
composition.

This document states the current guarantee and the separate authenticated-local-
runtime direction. It does not claim that future identity work is already
implemented.

## Current Boundary

Installed Userland is served by the local backend at the configured loopback
origin. The Admin development/Vite origin is a separate listener. Exact values
and modes are owned by the [port catalog](../ports/01-port-catalog.md) and
settings manifest.

Current backend mutations require:

- an allowed normalized `Host`;
- an allowed normalized browser `Origin`;
- an `X-ArtGod-CSRF` token matching the `HttpOnly`, `SameSite=Strict` CSRF
  cookie.

Those checks protect normal cross-site request paths. They do not authenticate
the process serving an allowed loopback origin. A process that legitimately
controls that origin can obtain a CSRF response and send same-origin writes.

The desktop supervisor also checks listener/process health and owns child
lifecycle. A successful port or HTTP health probe proves responsiveness, not
cryptographic runtime identity.

## Security Claims and Non-Claims

The public-alpha boundary assumes the user-selected RPC endpoints report chain
state truthfully and treats ordinary Userland/browser input as untrusted
proposals.

For bidding, this means:

- a browser can propose, revise, pause, or archive jobs through backend use
  cases;
- native review grants an immutable per-process authorization for exact
  collection identity and per-offer limits;
- the restricted signer validates marketplace payloads against that
  authorization before signing or sending the one allowed approval transaction;
- there is no aggregate spend/job/open-order budget within those per-offer caps.

Wallet passphrases and private keys do not cross HTTP. Rust owns encrypted
keystores, the native prompt, authorization review, one-shot secret handoff, and
parent-liveness containment. See
[Wallet Keystore and Bot Unlock](03-wallet-keystore-and-bot-unlock.md).

The current model does not protect against arbitrary code execution in Tauri
core or the privileged Admin WebView, same-user process-memory access, or direct
writes to app-data, SQLite, keystore, or runtime files. Those are host-compromise
capabilities outside the public-alpha threat model.

## Local Port Impersonation

The unresolved threat is a stale or hostile local process that:

- binds an expected backend/frontend port before ArtGod starts;
- keeps serving an old composition after the supervisor expects a fresh one;
- returns a healthy-looking response from the wrong runtime;
- serves browser content from an allowed origin and submits same-origin writes.

CSRF, CORS, and same-origin policy do not solve this because the impersonator
owns the already-trusted origin. Process-name checks and response-body magic
strings are similarly weak identity signals.

## Why A Browser Bearer Secret Is Insufficient

A per-run or per-install secret helps only while arbitrary JavaScript on the
trusted origin cannot read or replay it. These shapes do not add meaningful
identity:

- returning the secret to browser JavaScript;
- embedding it in static Userland assets;
- sending it over ordinary browser-visible loopback HTTP;
- asking an unauthenticated local frontend proxy to inject it.

A supervisor-owned credential can still authenticate child-to-child calls when
it never enters the browser. That secures a process channel; it does not by
itself tell a system browser that the peer is the intended signed ArtGod app.

## Transport Identity

Loopback HTTPS is useful when the client authenticates the exact peer. Encryption
alone does not solve port ownership.

Weak shapes include unpinned self-signed certificates, click-through browser
warnings, or one broadly shared certificate/private key. A useful supervisor
channel would instead:

1. let Rust create/load per-install identity material in app-data;
2. give derived certificate material only to the expected child runtimes;
3. make those runtimes fail closed when identity is missing or malformed;
4. pin the expected certificate or local CA in supervisor health checks;
5. classify a responding wrong certificate as port impersonation, not ordinary
   startup delay;
6. rotate/remove identity material through an explicit desktop lifecycle.

This establishes supervisor-to-runtime identity. Browser-to-runtime trust is a
different problem because executable code signing and browser TLS trust stores
are separate systems.

## Browser Trust Options

### Per-install local trust root

An installer or explicitly approved native flow can install a narrowly scoped
local CA and issue runtime certificates. Browsers receive normal TLS identity,
but installation, removal, rotation, Linux distribution variance, and Firefox
trust-store behavior create significant security and support burden.

### Public hostname and certificate

A public ArtGod-controlled name can resolve to loopback and use a publicly
trusted certificate. Browser UX is simpler, but the private key is not naturally
per-install; any holder can impersonate the local endpoint. Supervisor pinning
would still be required.

### Authenticated supervisor channel, browser HTTP unchanged

The supervisor can detect stale/wrong runtime owners while Userland keeps the
current HTTP origin. This improves composition integrity but does not give the
browser transport identity. It is useful only if privileged browser writes stay
bounded by other native policy.

### Move privileged writes behind native commands

System-browser Userland can remain read-mostly while sensitive writes enter
through the signed Tauri/native boundary. This avoids browser trust-store
distribution for those actions but changes product flows and does not remove the
need to authenticate supervised runtime listeners.

## Decision Boundary

Current policy is:

- keep CSRF focused on browser cross-site protection;
- keep the installed Userland origin allowed while the current desktop serving
  model exists;
- keep secrets and final signer authority outside HTTP;
- treat local port ownership/authenticated runtime identity as a dedicated
  desktop security feature, not a CSRF tweak;
- do not install a local trust root or expose a browser bearer secret without a
  cross-platform lifecycle and threat-model review.

A future implementation must decide:

- which production listeners need cryptographic identity;
- whether the browser calls the backend directly or through an authenticated
  local server component;
- which writes, if any, move behind native commands;
- whether local trust-root installation is acceptable on Linux, macOS, Windows,
  and Firefox;
- backup, rotation, revocation, uninstall, and wrong-runtime recovery UX.

## Required Verification For A Future Identity Layer

The maintained desktop harness must cover:

- expected process and certificate identity;
- port already owned by a fake responder;
- stale ArtGod process on an expected port;
- wrong, expired, rotated, missing, and malformed certificate material;
- supervisor restart and identity preservation/rotation;
- clear fail-closed user recovery without weakening listener boundaries;
- removal of trust material during uninstall or explicit reset.

Do not improvise system display automation for this work. Native rendered states
need a maintained native harness or explicit user QA; listener/certificate state
can be tested through repository-owned process and network fixtures.

## Current Limits and Future Direction

Authenticated local runtime identity is not implemented. The outcome is tracked
as `BKL-052` in the [unified backlog](../planning/01-unified-backlog.md). Until it
lands, loopback exposure, desktop child ownership, backend request checks, and
native signer policy are complementary defenses, not proof of browser/runtime
identity.
