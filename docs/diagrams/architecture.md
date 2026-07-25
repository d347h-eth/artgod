# ArtGod System Architecture

ArtGod has no centralized application server. The desktop composition and the
optional hosted composition are operator-run deployments of the same
backend/worker/broker/database software stack, and each deployment owns its own
state. The Rust supervisor and Docker Compose are alternative composition roots,
not concurrent launchers. Hosted mode narrows the public HTTP surface; it does
not move canonical state to an ArtGod service.

```mermaid
flowchart LR
    subgraph Clients[User-facing clients]
        Admin[Desktop Admin<br/>Tauri WebView]
        LocalUI[Desktop Userland<br/>static browser app]
        HostedUI[Hosted read-only UI<br/>SvelteKit SSR]
    end

    subgraph Composition[Operator-run composition]
        Supervisor[Rust desktop supervisor<br/>desktop only]
        Compose[Docker Compose<br/>hosted only]
        Backend[Backend HTTP adapters<br/>and use cases]
        Cache[Backend query cache]
        NATS[NATS JetStream<br/>wake-ups and work delivery]
        Scheduler[Scheduler and reorg workers]
        Bootstrap[Bootstrap workers<br/>durable step scheduler]
        Ingest[Sync and offchain ingest workers]
        Domain[Domain workers<br/>orders, metadata, activities]
        Extensions[Collection-extension worker]
        Recovery[Dead-letter worker]
        Trading[Wallet-bound trading bot<br/>desktop only]
        DB[(SQLite<br/>canonical and durable control state)]
        Media[(Local token image cache)]
    end

    subgraph External[Public external systems]
        RPC[Ethereum JSON-RPC and WebSocket]
        OpenSea[OpenSea REST and Stream]
        Metadata[Metadata HTTP and IPFS]
    end

    Admin -->|Tauri commands| Supervisor
    Supervisor -->|desktop starts and monitors| NATS
    Supervisor --> Backend
    Supervisor --> Scheduler
    Supervisor --> Bootstrap
    Supervisor --> Ingest
    Supervisor --> Domain
    Supervisor --> Extensions
    Supervisor --> Recovery
    Supervisor -->|explicit unlock and start| Trading

    Compose -->|hosted starts| HostedUI
    Compose --> NATS
    Compose --> Backend
    Compose --> Scheduler
    Compose --> Bootstrap
    Compose --> Ingest
    Compose --> Domain
    Compose --> Extensions
    Compose --> Recovery

    LocalUI -->|same-origin HTTP| Backend
    HostedUI -->|read-only backend contract| Backend
    Backend -->|read models and transactions| DB
    Backend <--> Cache
    Backend -->|bootstrap and trading wakes| NATS
    Backend -->|token URI and owner resolution| RPC

    Scheduler -->|scheduled work| NATS
    NATS -->|reorg work| Scheduler
    NATS --> Bootstrap
    Bootstrap -->|follow-up work| NATS
    NATS --> Ingest
    Ingest -->|projection work| NATS
    NATS --> Domain
    Domain -->|follow-up work| NATS
    NATS --> Extensions
    Extensions -->|statistics follow-up| NATS
    NATS --> Recovery
    NATS --> Trading

    Scheduler -->|scheduling and reorg state| DB
    Bootstrap -->|runs, steps, tasks, snapshots| DB
    Ingest -->|blocks and raw observations| DB
    Domain -->|canonical projections and stats| DB
    Extensions -->|artifacts and extension traits| DB
    Trading -->|jobs, commands, runtime state, bid-book projection| DB

    Bootstrap --> RPC
    Bootstrap --> Metadata
    Ingest --> RPC
    Ingest --> OpenSea
    Domain --> RPC
    Domain --> Metadata
    Extensions --> RPC
    Extensions --> Metadata
    Trading --> RPC
    Trading --> OpenSea

    Bootstrap --> Media
    Domain --> Media
    Backend --> Media
```

## Durable-State Boundary

- SQLite, not JetStream delivery, owns bootstrap progress, declared trading
  jobs, command reconciliation, canonical indexed state, and read projections.
- JetStream carries scheduler wake-ups and bounded work such as realtime sync,
  backfill, metadata refresh, metadata statistics, activity upsert, OpenSea raw
  observations, and dead-letter handling.
- OpenSea stream events and Ethereum WebSocket heads are hints. Canonical chain
  reads, reconciliation, snapshots, and durable cursors recover missed or
  duplicate delivery.

Follow the [backend architecture](../backend/01-api-and-application-architecture.md),
[indexer overview](../indexer/00-overview.md), and
[bidding runtime](../trading/01-bidding-runtime-and-jobs.md) for exact ownership.
