# ArtGod System Architecture

ArtGod has no centralized application server. The desktop composition and the
optional hosted composition are both operator-run deployments of the same local
backend, workers, queue broker, and database. The hosted mode narrows the public
HTTP surface; it does not move canonical state to an ArtGod service.

```mermaid
flowchart LR
    subgraph Clients[User-facing clients]
        Admin[Desktop Admin<br/>Tauri WebView]
        LocalUI[Desktop Userland<br/>static browser app]
        HostedUI[Hosted read-only UI<br/>SvelteKit SSR]
    end

    subgraph Composition[Operator-run composition]
        Supervisor[Rust desktop supervisor]
        Backend[Backend HTTP adapters<br/>and use cases]
        Cache[Backend query cache]
        NATS[NATS JetStream<br/>wake-ups and work delivery]
        Scheduler[Scheduler and reorg workers]
        Bootstrap[Bootstrap workers<br/>durable step scheduler]
        Ingest[Sync and offchain ingest workers]
        Domain[Domain workers<br/>orders, metadata, activities]
        Extensions[Collection-extension worker]
        Trading[Wallet-bound trading bot]
        DB[(SQLite<br/>canonical and durable control state)]
        Media[(Local token image cache)]
    end

    subgraph External[Public external systems]
        RPC[Ethereum JSON-RPC and WebSocket]
        OpenSea[OpenSea REST and Stream]
        Metadata[Metadata HTTP and IPFS]
    end

    Admin -->|Tauri commands| Supervisor
    Supervisor -->|starts and monitors| NATS
    Supervisor -->|starts and monitors| Backend
    Supervisor -->|starts and monitors| Scheduler
    Supervisor -->|explicit unlock and start| Trading

    LocalUI -->|same-origin HTTP| Backend
    HostedUI -->|internal SSR and public API reads| Backend
    Backend -->|read models and transactions| DB
    Backend <--> Cache
    Backend -->|bootstrap and trading wakes| NATS
    Backend -->|token URI and owner resolution| RPC

    Scheduler -->|realtime, backfill, and reorg work| NATS
    NATS --> Bootstrap
    NATS --> Ingest
    NATS --> Domain
    NATS --> Extensions
    NATS --> Trading

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
    Backend --> Media
```

## Durable-State Boundary

- SQLite, not JetStream delivery, owns bootstrap progress, declared trading
  jobs, command reconciliation, canonical indexed state, and read projections.
- JetStream carries scheduler wake-ups and bounded work such as realtime sync,
  backfill, metadata refresh, metadata statistics, activity upsert, OpenSea raw
  observations, and dead-letter handling.
- External streams are hints. Canonical chain reads, reconciliation, snapshots,
  and durable cursors recover missed or duplicate delivery.

Follow the [backend architecture](../backend/01-api-and-application-architecture.md),
[indexer overview](../indexer/00-overview.md), and
[bidding runtime](../trading/01-bidding-runtime-and-jobs.md) for exact ownership.
