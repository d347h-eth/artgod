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
    Sync->>RPC: getLogs + extension watch logs + getBlock + getTx + getReceipts
    Sync->>DB: Persist blocks/transfers/fills/balances
    Sync->>NATS: Publish domain sync jobs
    Sync->>NATS: Publish targeted order update jobs
    Sync->>NATS: Publish metadata refresh jobs (core + extension-derived)

    NATS-->>Domain: Deliver domain sync + order jobs
    Domain->>DB: Persist activities / metadata / orders
```

## Collection Bootstrap + OpenSea Bootstrap

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    participant API as Backend API
    participant Bootstrap as Bootstrap Worker
    participant DB as SQLite
    participant NATS as NATS JetStream
    participant RPC as RPC / metadata HTTP
    participant Ext as Collection Extension Worker
    participant OSBoot as OpenSea Bootstrap Worker
    participant Offchain as Offchain Ingest Worker
    participant Domain as Domain Worker

    Admin->>API: Probe and approve collection scope
    API->>DB: Create run + planned durable steps
    API->>NATS: Publish bootstrap wakeup
    NATS-->>Bootstrap: bootstrap.collection.start

    loop Main and image-cache lane polls
        Bootstrap->>DB: Reconcile dependencies + claim step lease
        alt Anchor
            Bootstrap->>RPC: Read anchor block
            Bootstrap->>DB: Persist anchor
            Bootstrap->>DB: Persist extension install if requested
        else Enumeration
            Bootstrap->>RPC: Resolve approved token scope
            Bootstrap->>DB: Mark enumeration succeeded
            Bootstrap->>DB: Seed metadata tasks in batches
        else Metadata / ownership
            Bootstrap->>RPC: Fetch canonical metadata / ownerOf at anchor
            Bootstrap->>DB: Settle durable tasks + progress
        else Image cache
            Bootstrap->>RPC: Fetch bounded source media
            Bootstrap->>DB: Settle cache task + file record
        else Backfill
            Bootstrap->>DB: Mark delegated step running
            Bootstrap->>NATS: Publish collection-scoped catch-up
        else Collection live
            Bootstrap->>DB: Mark collection live
            Bootstrap->>DB: Mark step succeeded
            Bootstrap->>DB: Mark run completed
            Bootstrap->>DB: Clean eligible successful temporary rows
        end
    end

    par Extension side work after metadata
        Bootstrap->>DB: Seed/observe extension artifact tasks
        Bootstrap->>NATS: Publish collection-extension.refresh-artifacts
        NATS-->>Ext: collection-extension.refresh-artifacts
        Ext->>DB: Claim per-task lease
        Ext->>RPC: Read/render collection-owned artifacts
        Ext->>DB: Upsert artifact/traits
        Ext->>DB: Settle task under the current lease fence
    and OpenSea side work after metadata and ownership
        Bootstrap->>NATS: Publish opensea.collection.bootstrap job
        NATS-->>OSBoot: OpenSea bootstrap job
        OSBoot->>DB: Start collection snapshot run
        OSBoot->>RPC: Fetch OpenSea listing/offer pages
        OSBoot->>NATS: Publish offchain.order.raw snapshot jobs
        OSBoot->>DB: Mark missing source orders inactive
        OSBoot->>DB: Mark collection OpenSea-ready
        OSBoot->>DB: Complete source run
    end

    NATS-->>Offchain: offchain.order.raw
    Offchain->>DB: Optionally record raw observation
    Offchain->>NATS: Publish order work

    NATS-->>Domain: orders.upsert
    Domain->>DB: Persist canonical order
    Domain->>NATS: Publish orders.update-by-id(reason=order)
    NATS-->>Domain: orders.update-by-id
    Domain->>DB: Validate Seaport order and update fillability_status
```

## Canonical Metadata Refresh + Collection Extension Artifacts

```mermaid
sequenceDiagram
    autonumber
    participant Sync as Sync Worker
    participant NATS as NATS JetStream
    participant Domain as Domain Worker
    participant DB as SQLite
    participant Ext as Collection Extension Worker
    participant RPC as RPC Node
    participant MetaHTTP as Metadata Fetcher

    Sync->>NATS: Publish metadata refresh job
    NATS-->>Domain: metadata refresh job
    Domain->>RPC: Resolve tokenURI
    Domain->>MetaHTTP: Fetch / parse metadata
    Domain->>DB: Commit canonical metadata
    Domain->>DB: Persist follow-up run, tasks, and outbox jobs
    Domain->>NATS: Drain collection-extension.refresh-artifacts outbox

    NATS-->>Ext: collection-extension.refresh-artifacts
    Ext->>DB: Read enabled install + normalized attributes
    Ext->>RPC: Read collection-specific artifact inputs
    Ext->>MetaHTTP: Parse/fetch extension metadata if needed
    Ext->>DB: Upsert artifact/traits, then mark task terminal
    alt Last required extension task is terminal
        Ext->>DB: Finalize follow-up + insert stats outbox row
        Domain->>NATS: Drain metadata stats recompute outbox
        NATS-->>Domain: domain.metadata.stats-recompute
        Domain->>DB: Replace collection trait stats transactionally
    end
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

    loop Eligible live or bootstrapping collections
        Stream->>OSStream: Subscribe/refresh per enabled slug
        Stream->>DB: Touch subscription-refresh timestamp
        OSStream-->>Stream: item_listed / bids / cancels / etc
        Stream->>NATS: Publish offchain.order.raw (channel=stream)
        Stream->>DB: Touch last-event timestamp
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
    Reconcile->>DB: Mark reconcile completed
    Reconcile->>DB: Mark collection OpenSea-ready
    Reconcile->>DB: Complete source run

    NATS-->>Offchain: offchain.order.raw
    Offchain->>DB: Optionally append raw observation
```
