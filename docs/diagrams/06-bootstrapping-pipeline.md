# Bootstrap Pipeline Sequence

This diagram describes the current scheduler-first bootstrap implementation.
It is meant to clarify runtime ownership rather than restate every executor
detail.

The source of truth is durable SQLite state:

- `bootstrap_runs` stores the request/config snapshot and top-level run state.
- `bootstrap_run_steps` stores the planned pipeline, dependencies, leases,
  health-check deadlines, progress, timing, and terminal results.
- Step task tables store fan-out work for metadata, ownership, image cache, and
  collection-extension artifact refresh.

Queue messages are wake-ups and delegated work delivery. They reduce latency,
but they are not the source of pipeline state.

## Runtime Shape

`CollectionBootstrapWorker` owns the bootstrap scheduler. It currently starts
two scheduler pollers:

- main lane: anchor, enumeration, metadata, ownership, backfill,
  collection-live, OpenSea phase handoff, and collection-extension artifact
  handoff
- image-cache lane: image-cache task processing

OpenSea bootstrap and collection-extension artifacts are not separate scheduler
lanes in this implementation. They are planned bootstrap steps in
`bootstrap_run_steps`, but their actual work is delegated to queue consumers.
Those consumers update the same durable step/task rows so the run detail UI can
still show coherent progress and terminal state.

## Progress And Liveness

The scheduler claims due steps with a local lease. While a claimed processor is
running, `BootstrapStepProgressObserver` reads existing durable progress and
lets lease renewal continue only while the step is observably alive. If progress
stops changing beyond the configured stale-progress window, lease renewal stops;
the expired lease then becomes normal scheduler recovery work.

Delegated work is represented as a running step with a health-check deadline
rather than a local lease. When that deadline becomes due, the main scheduler
can claim the step again and decide whether to republish work, observe terminal
state, or retry.

Pause/resume is currently step-level and exposed for metadata and image cache.

## Sequence

```mermaid
sequenceDiagram
    autonumber

    actor User as Admin UI
    participant API as Backend API
    participant DB as SQLite bootstrap state
    participant Q as NATS queue
    participant BW as CollectionBootstrapWorker
    participant Main as Main scheduler lane
    participant Image as Image-cache scheduler lane
    participant Obs as BootstrapStepProgressObserver
    participant Ext as Extension artifact worker
    participant OS as OpenSea bootstrap worker
    participant Net as RPC / HTTP / IPFS
    participant Detail as Run detail UI

    User->>API: Submit collection bootstrap request
    API->>DB: Insert bootstrap run and request snapshot
    API->>DB: Plan bootstrap_run_steps with dependencies
    API->>Q: Publish collection-bootstrap wake

    par Durable scheduler pollers
        BW->>Main: Poll due main-lane steps
        BW->>Image: Poll due image-cache steps
    and Wake delivery
        Q-->>BW: Deliver bootstrap wake
        BW->>Main: Run immediate main-lane pass
    end

    loop Scheduler pass per lane
        Main->>DB: Reconcile dependency-satisfied pending steps
        DB-->>Main: Ready steps
        Main->>DB: Claim due ready/retry/expired running step
        Main->>Obs: Start progress-observed lease renewal

        alt Anchor
            Main->>Net: Read anchor block through shared RPC harness
            Main->>DB: Persist anchor and terminal step state
        else Enumeration
            Main->>Net: Resolve token IDs through shared RPC harness
            Main->>DB: Seed metadata and ownership task tables
            Main->>DB: Persist enumeration progress and terminal state
        else Metadata
            Main->>Net: Read tokenURI and fetch metadata payloads
            Main->>DB: Upsert token metadata and task counts
            alt More metadata work remains
                Main->>DB: Release step ready with next due timestamp
            else Metadata settled
                Main->>DB: Mark metadata terminal
            end
        else Ownership
            Main->>Net: Read ownerOf at the anchor block
            Main->>DB: Upsert ownership snapshot task results
            alt Ownership failures remain terminal
                Main->>DB: Mark ownership and run failed
            else Ownership settled
                Main->>DB: Mark ownership terminal
            end
        else Backfill
            Main->>DB: Mark delegated running with health-check deadline
            Main->>Q: Publish idempotent backfill work
        else Collection live
            Main->>DB: Mark collection live and blocking path complete
            Main->>Q: Wake non-blocking side work when due
        else OpenSea phase
            Main->>DB: Release phase as running with health-check deadline
            Main->>Q: Publish OpenSea bootstrap job
        else Collection-extension artifacts
            Main->>DB: Seed or observe artifact task counts
            Main->>DB: Release step as running with health-check deadline
            Main->>Q: Publish artifact refresh jobs
        end

        Obs->>DB: Read current step progress fingerprint
        alt Progress changed before stale deadline
            Obs-->>Main: Lease may renew
            Main->>DB: Renew local step lease
        else Progress stale
            Obs-->>Main: Stop renewing
            DB-->>Main: Expired lease becomes reclaimable later
        end

        Main->>DB: Validate processor outcome against persisted step state
        Main->>DB: Reconcile downstream dependencies
        Main->>Q: Wake image-cache lane if image work is ready
    end

    loop Image-cache lane
        Image->>DB: Claim due image-cache step
        Image->>Obs: Start progress-observed lease renewal
        Image->>DB: Claim due image-cache tasks
        Image->>Net: Fetch token image media
        Image->>DB: Write token_image_cache rows and task progress
        alt More image-cache work remains
            Image->>DB: Release image-cache step ready with next due timestamp
        else Image cache settled
            Image->>DB: Mark image-cache step terminal
            Image->>DB: Cleanup succeeded image-cache task rows
        end
    end

    par Delegated collection-extension work
        Q-->>Ext: Deliver artifact refresh job
        Ext->>DB: Update artifact task rows
        Ext->>DB: Mark artifact step terminal or retryable when settled
        Ext->>Q: Schedule artifact retry when needed
    and Delegated OpenSea bootstrap
        Q-->>OS: Deliver OpenSea bootstrap job
        OS->>Net: Resolve identity and snapshot orderbook state
        OS->>DB: Mark OpenSea phase rows running, succeeded, retry, or failed
        OS->>Q: Schedule OpenSea retry when needed
    and Run detail polling
        Detail->>API: Poll bootstrap run detail
        API->>DB: Read run, step rows, and task counts
        DB-->>API: Step state, progress, actions, errors
        API-->>Detail: Render flow chips and controls
    end

    opt User pause/resume
        User->>API: Pause metadata or image cache
        API->>DB: Mark step paused and clear local lease
        API->>Q: Wake scheduler

        User->>API: Resume metadata or image cache
        API->>DB: Mark step ready with current due timestamp
        API->>Q: Wake scheduler
    end

    opt Restart, lost wake, or duplicate delivery
        BW->>DB: Poll due durable step rows
        DB-->>BW: Ready, retryable, or expired running steps
        BW->>Main: Continue from durable state
        BW->>Image: Continue from durable state
    end
```

## Reading The Diagram

- A claimed local step is protected by a lease, not by the queue message that
  woke the scheduler.
- The progress observer is read-only. It does not write task progress; it only
  decides whether local lease renewal is still justified.
- A delegated step keeps its bootstrap step row authoritative even while the
  work runs in another queue consumer.
- `collection_live` marks the blocking bootstrap path complete. Non-blocking
  work such as image cache, OpenSea bootstrap, and collection-extension artifact
  refresh can continue independently of that marker.
- The run detail UI should be explainable from `bootstrap_run_steps` plus task
  counts. Worker-local state should never be required to understand progress.
