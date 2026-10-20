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

    RPC-->>Scheduler: Head update wakes HTTP sampling
    Scheduler->>DB: Capture local admission watermark
    Scheduler->>RPC: Read head (HTTP)
    Scheduler->>DB: Retain sampled target and admission coverage
    Scheduler->>NATS: Publish realtime wakeup
    NATS-->>Sync: Deliver wakeup
    Sync->>Sync: Wake the serial coordinator
    Sync->>NATS: ACK wakeup
    loop Retained current target has an unapplied prefix
        Sync->>RPC: Fetch next connected logs, headers, transactions and receipts
        Sync->>DB: Atomic facts, ownership, canonical order effects, checks, maker wakeups and applied progress
    end
    Domain->>DB: Read due required follow-ups
    Domain->>NATS: Publish activity/metadata jobs and compact maker continuations
    Domain->>DB: Remove accepted sync intent; retry failed publication
    NATS-->>Domain: Deliver projections and maker continuations
    Domain->>DB: Check event origin hash before admission
    Domain->>DB: Project activities/metadata; expand maker scopes into ordinary demand
```

## Perpetual Collection Gap Repair

```mermaid
sequenceDiagram
    participant Scanner as Sync Worker Gap Discovery
    participant DB as SQLite
    participant Sync as Sync Coordinator
    participant RPC as RPC Node
    participant Domain as Domain Worker Outbox Drainer
    participant NATS as NATS JetStream

    loop Bounded discovery pages, including unchanged heads
        Scanner->>DB: Page live collections and saved scan progress
        Scanner->>DB: Stream bounded descending collection coverage up to HEAD - depth
        alt Missing coverage and no pending repair
            Scanner->>DB: Save cursor and one pending range per collection
        end
    end
    loop Continuous bounded passes; poll only when idle or waiting
        Sync->>DB: Check newest pending height and due HEAD-check times
        Sync->>Sync: Prioritize current applied prefixes and retained recovery
        Sync->>RPC: Read HEAD when a range or HEAD check is due
        opt Collection HEAD check overdue by 30 minutes
            Sync->>DB: Find newest missing blocks above pending range or cursor
            Sync->>DB: Save check time; replace range/cursor only if newer hole found
        end
        Sync->>DB: Select ready members at newest pending height, LIMIT 16
        Sync->>DB: Recheck bounded coverage; trim covered suffixes and reselect priority
        Sync->>RPC: Fetch one common suffix for participating collections
        alt Valid acquisition and retained owners
            Sync->>DB: Atomic data, required follow-ups and exact member progress
        else Acquisition or commit failed
            Sync->>DB: Delay only failed member identities
        end
    end
    Domain->>DB: Read retained follow-up intent
    Domain->>NATS: Publish required jobs with stable IDs
    Domain->>DB: Remove accepted intent or retain retry with capped delay
    Note over Scanner,DB: Completed cycles wait until the next recheck; saved check time includes downtime
    Note over Sync,DB: Historical repair cannot advance accepted current-state prefixes
    Note over Sync,Domain: Failed publication repeats no RPC acquisition
```

## Durable Reorg Recovery

```mermaid
sequenceDiagram
    participant RPC as RPC Node
    participant DB as SQLite
    participant Sync as Sync Coordinator
    participant Domain as Domain Worker Outbox Drainer
    participant NATS as NATS JetStream

    Sync->>DB: Read one eligible pending stored hash and revision
    Sync->>RPC: Fresh header differs from stored hash
    Sync->>DB: Atomically retain mismatch and clear its pending check
    alt Retention fails
        Sync->>DB: Leave check pending with durable retry time
    else Mismatch retained
        Sync->>RPC: Complete bounded common-ancestor proof
        alt Proof unavailable
            Sync->>DB: Retain awaiting_ancestor with delayed retry
        else Verified ancestor
            Sync->>RPC: ownerOf at exact fork hash, requireCanonical
            Sync->>DB: Atomic checkpoints, rollback, revision and resync range
        end
    end
    loop Coordinator passes, independent of HEAD changes
        Sync->>DB: Read due awaiting_ancestor
        Sync->>RPC: Retry bounded proof and exact-hash snapshot
    end
    loop Continuous bounded sync passes
        Sync->>DB: Read one retained canonical range and eligible collections
        Sync->>RPC: Acquire canonical range through shared pipeline
        Sync->>DB: Atomic data, required follow-ups and next range or completion
    end
    Domain->>DB: Read independently retained follow-up intent
    Domain->>NATS: Publish stable revision-qualified jobs
    Domain->>DB: Remove accepted intent or retain required retry
    Note over DB,Sync: Failure before commit leaves acquisition pending; after commit publication needs no RPC
    Note over DB,Domain: Rollback keeps DB-range intent and removes orphan event intent; late orphan hints fail admission
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
    Domain->>DB: Commit canonical order and needed validation demand together
    Domain-->>NATS: ACK after commit
```

Validation continues through the local demand loop below; upsert completion
does not publish a second broker envelope or imply validation completion.

## Order Admission and Validation

Source consumers, maker expansion and ordinary validation are separate tasks in
one domain worker. The sync worker alone advances canonical applied state.
Only ordinary validation uses the two FIFO RPC permits. See
[processing ownership](07-domain-orders.md#processing-ownership-and-retained-state)
and [ports](12-ports-and-adapters.md#order-processing-ports).

```mermaid
sequenceDiagram
    autonumber
    participant Source as Source Consumer
    participant Sync as Sync Coordinator
    participant DB as SQLite
    participant Demand as Ordinary Validator
    participant RPC as RPC Node

    Source->>DB: Commit observation, declaration and causal demand
    Note over Source,DB: Sale is an observation; no receipt lookup or terminal assertion
    Source-->>Source: ACK after durable admission
    Sync->>RPC: Sample head after source admission
    Sync->>RPC: Acquire connected required ranges
    Sync->>DB: Commit facts, canonical effects, maker wakeups and applied progress
    Note over Sync,DB: No duplicate canonical by-ID or maker event publication
    loop Poll ready demand
        Demand->>DB: Check causal barrier and shared/collection coverage
        Demand->>Demand: Acquire FIFO capacity
        Demand->>DB: Claim revisions, generations, lease and exact checkpoint
        Demand->>RPC: Full validation at supplied block hash
        Demand->>RPC: Fresh canonicality and snapshot-lifetime verification
        alt Compatible proof and claim remain current
            Demand->>DB: Commit result, independent proof and covered demand
        else RPC uncertainty, dispute or changed claim
            Demand->>DB: Keep unfinished demand retryable; retain dispute if needed
        end
        Demand->>DB: Release unconsumed claims
        Demand->>Demand: Release capacity and yield
    end
```

## Maker Checkpoint and Recovery

A maker step expands a finite candidate page into ordinary demand without RPC.
The checkpoint commits that handoff, cursor and next continuation together.
The outbox's sent receipt is publication evidence, not execution completion.

```mermaid
sequenceDiagram
    autonumber
    participant Sync as Sync Writer
    participant NATS as NATS JetStream
    participant Maker as Maker or Token Handler
    participant DB as SQLite
    participant Outbox as Outbox Publisher
    participant Recovery as Maker Recovery

    opt Canonical maker event
        Sync->>DB: Check indexed candidates and admit relevant scope
        Sync->>DB: Retain one continuation atomically with applied progress
    end
    NATS-->>Maker: Fresh source scope or chain/run/step continuation
    Maker->>Maker: Verify transport identity, owning queue and delivery receipt
    Maker->>DB: Admit or resume retained pass and claim lease
    alt Bounded expansion succeeds
        Maker->>DB: Commit ordinary demand, cursor and continuation
        Maker-->>NATS: ACK
    else Expansion fails after admission
        Maker->>DB: Durably release lease with failure
        Maker-->>NATS: ACK only after recovery owns unfinished work
    else Admission or release remains uncertain
        Maker-->>NATS: Retain delivery for retry
    end
    opt Pass or newer generation still needs a step
        Outbox->>DB: Read committed continuation
        Outbox->>NATS: Publish compact next step
        Outbox->>DB: Record stream/sequence receipt
    end
    loop Periodic bounded recovery and cleanup
        Recovery->>DB: Read unfinished runs and contributing delivery receipts
        Recovery->>NATS: Verify publication and each consumer ACK boundary
        Recovery->>DB: Repair missing wakeups; reap eligible completed receipts
    end
    Note over DB: Completed expansion may coexist with unfinished ordinary demand
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
