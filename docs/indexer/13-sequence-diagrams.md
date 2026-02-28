# Sequence Diagrams (High-Level)

These Mermaid diagrams provide a top-level, C4-style view of how indexer containers and queues interact. They are intentionally high-level and omit internal details.

## Realtime Sync + Domain Fanout

```mermaid
sequenceDiagram
    autonumber
    participant RPC as RPC Node (HTTP/WS)
    participant SchedulerWorker as Scheduler-Worker Runtime
    participant NATS as NATS JetStream
    participant Sync as Sync Worker
    participant DB as SQLite Storage
    participant Domain as Domain Worker

    RPC-->>SchedulerWorker: Head update (WS)
    SchedulerWorker->>RPC: Poll head (HTTP)
    SchedulerWorker->>NATS: Publish Realtime Sync job(s)

    NATS-->>Sync: Deliver sync job
    Sync->>RPC: getLogs + getBlock
    Sync->>DB: Persist blocks/transfers/balances
    Sync->>NATS: Publish domain jobs

    NATS-->>Domain: Deliver domain jobs
    Domain->>DB: Orders/Metadata/Activities updates
```

## Reorg Check + Rollback + Resync

```mermaid
sequenceDiagram
    autonumber
    participant SchedulerWorker as Scheduler-Worker Runtime
    participant NATS as NATS JetStream
    participant Reorg as Reorg Worker
    participant RPC as RPC Node (HTTP)
    participant DB as SQLite Storage
    participant Sync as Sync Worker

    SchedulerWorker->>NATS: Publish block-check job
    NATS-->>Reorg: Deliver block-check job
    Reorg->>DB: Read stored block hash
    Reorg->>RPC: Fetch canonical block

    alt Hash matches
        Reorg-->>NATS: Ack job (no action)
    else Hash mismatch
        Reorg->>DB: Rollback from fork point
        Reorg->>NATS: Publish backfill range jobs
        NATS-->>Sync: Deliver backfill job(s)
        Sync->>RPC: getLogs + getBlock
        Sync->>DB: Persist corrected data
        Sync->>NATS: Publish domain jobs
    end
```
