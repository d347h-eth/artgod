# Sequence Diagrams (High-Level)

These Mermaid diagrams show the current high-level runtime interactions for the indexer and the OpenSea offchain pipeline.

## Realtime Sync + Domain Fanout

```mermaid
sequenceDiagram
    autonumber
    participant RPC as RPC Node (HTTP/WS)
    participant Scheduler as Scheduler Worker
    participant NATS as NATS JetStream
    participant Sync as Sync Worker
    participant DB as SQLite
    participant Domain as Domain Worker

    RPC-->>Scheduler: Head update (WS)
    Scheduler->>RPC: Poll head (HTTP)
    Scheduler->>NATS: Publish realtime sync jobs
    Scheduler->>NATS: Publish block-check jobs

    NATS-->>Sync: Deliver sync job
    Sync->>RPC: getLogs + getBlock + getTx + getReceipts
    Sync->>DB: Persist blocks/transfers/fills/balances
    Sync->>NATS: Publish domain sync jobs
    Sync->>NATS: Publish targeted order update jobs
    Sync->>NATS: Publish metadata refresh jobs

    NATS-->>Domain: Deliver domain sync + order jobs
    Domain->>DB: Persist activities / metadata / orders
```

## Collection Bootstrap + OpenSea Bootstrap

```mermaid
sequenceDiagram
    autonumber
    participant Bootstrap as Bootstrap Worker
    participant RPC as RPC Node
    participant DB as SQLite
    participant NATS as NATS JetStream
    participant OSBoot as OpenSea Bootstrap Worker
    participant OSAPI as OpenSea REST API
    participant Offchain as Offchain Ingest Worker
    participant Domain as Domain Worker

    NATS-->>Bootstrap: bootstrap.collection.start
    Bootstrap->>RPC: Read head
    Bootstrap->>DB: Set collection bootstrapping + anchor
    Bootstrap->>RPC: Metadata snapshot
    Bootstrap->>DB: Persist metadata
    Bootstrap->>RPC: Ownership snapshot
    Bootstrap->>DB: Persist snapshot + balances
    Bootstrap->>NATS: Publish short backfill job
    Bootstrap->>NATS: Publish opensea.collection.bootstrap job

    NATS-->>OSBoot: OpenSea bootstrap job
    OSBoot->>OSAPI: Resolve collection by contract
    OSBoot->>DB: Persist OpenSea slug + snapshot status
    OSBoot->>OSAPI: Fetch full orderbook pages
    OSBoot->>NATS: Publish offchain.order.raw snapshot jobs
    OSBoot->>DB: Complete orderbook run + mark OpenSea ready

    NATS-->>Offchain: offchain.order.raw
    Offchain->>DB: Record raw observation
    Offchain->>NATS: Publish orders.upsert / order updates / metadata refresh

    NATS-->>Domain: orders.upsert
    Domain->>DB: Persist canonical order
    Domain->>NATS: Publish orders.update-by-id(reason=order)
    NATS-->>Domain: orders.update-by-id
    Domain->>DB: Validate Seaport order and update fillability_status
```

## OpenSea Stream + Reconcile

```mermaid
sequenceDiagram
    autonumber
    participant Stream as OpenSea Stream Worker
    participant OSStream as OpenSea Stream API
    participant ReconcileSched as OpenSea Reconcile Scheduler
    participant Reconcile as OpenSea Reconcile Worker
    participant OSAPI as OpenSea REST API
    participant NATS as NATS JetStream
    participant Offchain as Offchain Ingest Worker
    participant DB as SQLite

    loop live collections with OpenSea slug
        Stream->>OSStream: Subscribe per collection slug
        OSStream-->>Stream: item_listed / bids / cancels / etc
        Stream->>DB: Touch stream health timestamps
        Stream->>NATS: Publish offchain.order.raw (channel=stream)
    end

    loop every reconcile interval
        ReconcileSched->>DB: Find due or stale collections
        ReconcileSched->>NATS: Publish opensea.collection.reconcile
    end

    NATS-->>Reconcile: Reconcile job
    Reconcile->>DB: Mark reconcile started
    Reconcile->>OSAPI: Fetch full orderbook pages
    Reconcile->>NATS: Publish offchain.order.raw (channel=reconcile)
    Reconcile->>DB: Mark missing active source orders inactive
    Reconcile->>DB: Complete run + mark reconcile completed

    NATS-->>Offchain: offchain.order.raw
    Offchain->>DB: Append raw observation
```
