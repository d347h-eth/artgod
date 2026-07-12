# Local Runtime Identity and Browser Trust Backlog

This document captures deferred security work for authenticated local desktop runtime ownership.
It is intentionally separate from the CSRF tab-stability fix because the problem is broader than browser CSRF.

## Current Security Boundary

ArtGod desktop serves userland through local browser origins and accepts backend writes from configured local origins.
The production desktop browser UI uses `http://127.0.0.1:42701`, so that origin must remain trusted while this runtime shape exists.

Current CSRF protection is still useful, but it has a narrow purpose:

- It protects mutating backend routes from normal cross-site web pages.
- It does not authenticate which local process owns a trusted loopback origin.
- It does not protect against a stale or malicious local process serving from an allowed origin.
- It should not be treated as local runtime identity or local process authentication.

The backend allowlist model means ArtGod trusts whatever serves an allowed origin.
That is acceptable only if the desktop supervisor can reliably know that the expected ArtGod child processes own those origins.

## Relationship to the Wallet and Bidding Threat Model

This backlog does not describe a security guarantee implemented by the current
public alpha. Userland browser sessions, extensions, and raw loopback clients
remain untrusted bidding-job proposal sources. Within a collection already
included in the active bidding authorization, they may mutate any number of
jobs; the restricted signer enforces the reviewed price and quantity limits on
each offer, but not an aggregate strategy budget.

Arbitrary code execution in the privileged Admin WebView or Tauri core, direct
writes to SQLite, app-data, keystore, or runtime files, and same-user
process-memory access remain host-compromise capabilities outside the
public-alpha threat model. The current boundary does not add a bearer session
or claim authenticated local runtime identity. See
`docs/desktop/03-wallet-keystore-and-bot-unlock.md` for the canonical wallet and
bidding threat model.

## Problem Statement

The desktop supervisor can currently validate process health by checking ports and HTTP responses.
That is not enough for a hostile or stale local environment:

- another process can bind a trusted frontend or backend port before ArtGod starts
- a stale ArtGod process can keep serving an old runtime after the supervisor expects a fresh composition
- a fake process can return healthy-looking responses on the expected ports
- local HTTP gives the browser no authenticated proof that the runtime endpoint is the intended ArtGod runtime

The relevant threat is local port impersonation.
CSRF and same-origin checks do not solve that threat because an attacker who controls the trusted local origin can fetch the CSRF token and submit writes from that same origin.

## Instance Secrets Are Not Enough

A per-run or per-install secret only helps if arbitrary browser JavaScript on the trusted origin cannot read or replay it.

Weak forms:

- returning the secret to browser JavaScript
- embedding the secret into static userland assets
- sending the secret over ordinary local HTTP between browser-visible components
- relying on a frontend proxy to inject the secret while the proxy/backend identity is not authenticated

Those forms collapse into another bearer token exposed to the same origin that is already trusted.
If a fake local process can serve that origin, it can use the same browser capabilities.

Potentially useful forms:

- a supervisor-owned secret used only between supervisor and child runtimes
- a frontend/server process that injects a backend credential that browser JavaScript never receives
- backend accepting privileged writes only through an authenticated local channel, not from arbitrary browser-origin JavaScript
- Tauri/native command boundaries for privileged writes where the signed desktop shell owns the trust decision

Even these only help if the participating local processes are authenticated.

## HTTPS Is Necessary Only With Identity

HTTPS over loopback is valuable when it authenticates the peer.
It is not automatically valuable just because the transport is encrypted.

Weak forms:

- self-signed HTTPS that users must click through
- HTTPS with no certificate pinning for supervisor health checks
- a shared public certificate that is not bound to this install or this supervised runtime

Useful forms:

- supervisor verifies the exact expected runtime certificate fingerprint
- supervisor verifies a per-install local CA chain that it owns
- backend/frontend refuse to start with missing or mismatched runtime identity material
- wrong-certificate health responses are treated as port impersonation, not ordinary startup delay

For loopback traffic, authentication is the important property.
Encryption is secondary unless secrets or privileged commands cross the channel.

## Proposed Runtime Identity Model

A future implementation should make Rust the owner of desktop runtime identity:

1. Rust creates or loads per-install identity material in app-data.
2. Rust launches backend and frontend with certificate paths or short-lived derived certificates.
3. Supervisor health checks use HTTPS and verify the expected certificate fingerprint or CA chain.
4. A port that responds with the wrong certificate is treated as an impersonator.
5. The supervisor refuses startup or shuts down the composition when runtime identity does not match.
6. Backend/frontend startup fails fast if identity material is missing, malformed, or not scoped to the current install.

This solves supervisor-to-runtime identity.
It does not automatically solve browser-to-runtime trust.

## Browser-To-Runtime Trust Problem

System browsers do not normally know that a localhost HTTPS endpoint belongs to a signed desktop executable.
Platform code signing and browser TLS trust are separate trust systems.

Release signing can prove that an executable came from the ArtGod release signer.
It does not by itself:

- make `https://127.0.0.1:42701` trusted in Chrome, Safari, Firefox, or Edge
- bind a TCP port to the signed executable
- tell the browser that a localhost certificate belongs to the signed ArtGod process
- stop another process from presenting a different certificate unless the client verifies the expected identity

Release signing can still help indirectly:

- the signed Rust app or installer can be trusted to generate and store per-install TLS material
- the supervisor can verify it launched bundled runtime artifacts
- a signed installer may be allowed, with user/admin approval, to install local trust material
- signed update flow can preserve or rotate local identity material safely

The browser-facing problem is trust-store distribution, not only certificate generation.

## Browser Trust Options

### 1. Install A Local ArtGod Trust Root

The installer or Rust app creates a per-install local CA and installs it into the OS or browser trust store.
Runtime certificates for local ArtGod origins are issued from that CA.

Pros:

- browser gets normal HTTPS UX with no warnings
- certificates can be per-install
- runtime identity can be checked by both browser and supervisor when configured correctly

Cons:

- high security and UX burden
- requires elevated or explicit user approval on many systems
- trust-root removal and rotation must be reliable
- Linux trust stores vary across distributions
- Firefox may use its own trust store depending on installation and policy
- a local root CA is powerful and must be scoped, explained, and removable

### 2. Use A Public Domain And Public CA Certificate

Example shape: an ArtGod-owned hostname resolves to `127.0.0.1`, and the runtime serves a publicly trusted certificate for that hostname.

Pros:

- browser trust is easier
- no local root install
- standard browser HTTPS UX

Cons:

- not naturally per-install identity
- private key handling becomes sensitive
- any holder of the cert/key can impersonate that local endpoint
- still needs supervisor pinning to detect wrong local runtime identity
- DNS and domain ownership become part of a local-first desktop runtime path

This option is better for browser UX than for strong per-install runtime identity.

### 3. Keep Browser HTTP, Authenticate Supervisor-To-Runtime

The browser continues to use local HTTP.
The supervisor uses pinned HTTPS or another authenticated local channel for runtime health and ownership checks.

Pros:

- avoids browser trust-store complexity
- gives the supervisor a real way to detect port squatting
- preserves the current userland browser model

Cons:

- browser-to-runtime traffic still has no transport identity
- malicious local processes remain outside the browser security model once they own an allowed origin
- privileged browser-origin writes still depend on local port ownership enforcement

This may be pragmatic if the immediate goal is composition safety rather than browser transport authentication.

### 4. Move Privileged Writes Behind Native Boundaries

System-browser userland remains read-mostly or lower trust.
Privileged local writes go through the signed Tauri shell and native command boundary.

Pros:

- avoids requiring the system browser to trust a local certificate for sensitive writes
- aligns privileged operations with the signed desktop app
- reduces the blast radius of browser-origin spoofing

Cons:

- changes product flow
- bidding and other current userland write surfaces would need routing or UX changes
- still needs runtime identity for backend/supervisor composition correctness

## Deferred Design Questions

- Which origins are browser-facing in production desktop, and which are dev-only?
- Should backend and frontend both have authenticated runtime identities, or should only the backend be authenticated?
- Should the browser call the backend directly, or should userland go through a local frontend/proxy process?
- Can privileged writes remain in system-browser userland, or should some move behind Tauri/native commands?
- Is installing a local trust root acceptable for ArtGod's target users?
- How should local identity material be backed up, rotated, revoked, and removed?
- What is the failure UX when a fake or stale runtime is detected on a trusted port?
- How should Linux, macOS, Windows, and Firefox trust-store differences be handled?

## Deferred Implementation Slices

1. Document the desktop local-runtime threat model.
2. Inventory production and development loopback origins and ports.
3. Add supervisor health checks that verify runtime identity, not only HTTP status.
4. Add per-install runtime identity material managed by Rust.
5. Make backend/frontend startup fail fast on missing or mismatched identity material.
6. Add explicit port-impersonation detection and shutdown behavior.
7. Evaluate browser trust options with Linux/macOS/Windows packaging constraints.
8. Decide whether privileged userland writes remain browser-origin writes or move behind Tauri/native commands.
9. Add regression tests for fake-port, stale-process, wrong-cert, and missing-cert scenarios.

## Current Decision

Defer this work until it can be planned as a dedicated desktop runtime identity feature.
Do not fold it into CSRF handling.

Near-term rule:

- Keep CSRF focused on browser cross-site protection.
- Keep `http://127.0.0.1:42701` trusted while production desktop userland is served there.
- Treat local port ownership and runtime identity as a separate supervisor/security backlog item.
