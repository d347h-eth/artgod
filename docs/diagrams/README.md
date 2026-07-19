# Architecture Diagrams

These diagrams are supporting views of the domain documents; they do not create
separate contracts.

## Whole-System and HTTP Boundaries

- [System architecture](architecture.md)
- [Backend hexagonal request flow](07-backend-hexagonal-request-flow.md)
- [Hosted read-only topology](08-hosted-read-only-topology.md)

## Desktop Runtime

- [Desktop components](00-desktop-components.md)
- [Startup happy path](01-desktop-startup-happy-path.md)
- [Failure and restart loop](02-desktop-failure-and-restart-loop.md)
- [Window and tray operations](03-desktop-window-tray-operations.md)
- [Userland request path](04-desktop-userland-request-path.md)
- [Timing controls](05-desktop-timing-controls.md)
- [Runtime lifecycle sequence](desktop-runtime-lifecycle-sequence.md)
- [Wallet unlock and bot secret boundary](09-wallet-unlock-and-bot-secret-boundary.md)

## Indexer and Trading

- [Bootstrap pipeline](06-bootstrapping-pipeline.md)
- [Indexer sequence diagrams](../indexer/13-sequence-diagrams.md)
- [Bidding command and offer lifecycle](10-bidding-command-and-offer-lifecycle.md)

Keep diagrams small enough to answer one architectural question. For exact
fields, status values, and failure policy, follow the linked domain document.
