# Bidding Command and Offer Lifecycle

SQLite owns declared jobs and command state. JetStream reduces reaction latency,
while the bot's recovery scan makes command delivery durable.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Userland bidding controls
    participant API as Backend use case
    participant DB as SQLite jobs, commands, and runtime state
    participant Q as JetStream command signal
    participant Bot as Bidding bot
    participant Snap as Authoritative OpenSea snapshot lane
    participant Signer as Mandate-restricted signer
    participant OS as OpenSea
    participant Read as Bid-book read model

    User->>UI: Create, revise, pause, or archive a job
    UI->>API: Guarded local API mutation
    API->>DB: Transactionally write desired job and command row
    API->>Q: Publish wake only after commit
    API-->>UI: Return declared job state

    alt Wake arrives
        Q-->>Bot: Command signal
    else Wake is lost or duplicated
        Bot->>DB: Periodic pending-command recovery scan
    end

    Bot->>DB: Claim next ordered command
    Bot->>DB: Reload authoritative job revision

    alt Enabled create or update
        Bot->>Snap: Load or refresh usable collection market view
        Snap->>OS: Complete paginated REST snapshot as needed
        OS-->>Snap: Current offers
        Bot->>Bot: Evaluate bidder decision within native mandate
        alt Place or replace offer
            Bot->>Signer: Request exact typed-data signature
            Signer->>Signer: Enforce chain, identity, quantity, price, allowance, and fee policy
            Signer->>OS: Submit signed offer
            OS-->>Bot: Active order identity
            Bot->>DB: Persist active-order and decision state
        else No marketplace change
            Bot->>DB: Persist verified command completion
        end
    else Pause, archive, or cancel-active-offer
        Bot->>OS: Discover and cancel tracked active order
        Bot->>DB: Persist completed, retryable, or terminal cancellation state
    end

    Bot->>DB: Complete or reschedule command row
    Bot->>Read: Project fresh snapshot rows asynchronously
    Read->>DB: Replace collection bid-book projection transactionally

    par Steady-state recovery
        Bot->>Snap: Poll enabled collections with adaptive cadence
    and Event-driven pressure
        OS-->>Bot: Stream event wake-up hint
        Bot->>Bot: Coalesce by collection and scope
        Bot->>Snap: Request targeted refresh without changing authority
    and UI refresh
        UI->>API: Read jobs and bid books
        API->>DB: Select fresh bot projection or indexed-orders fallback
        API-->>UI: Market rows plus private own-job lifecycle context
    end
```

Offchain cancellation intentionally remains available when placement authority
is absent so paused or archived jobs can recover tracked offers. Stopping the
bot does not itself cancel existing OpenSea orders or revoke WETH allowance.

See [bidding runtime and jobs](../trading/01-bidding-runtime-and-jobs.md) and
[automation capabilities](../trading/02-bidding-automation-capabilities.md).
