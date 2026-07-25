# Bidding Wallet Unlock and Bot Secret Boundary

Every operator-visible bidding-bot start is a new native authorization and
unlock operation. The WebView can request the operation but never receives the
passphrase or private key.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Admin as Admin WebView
    participant Rust as Tauri command and bot supervisor
    participant Prompt as Native secret-prompt sidecar
    participant Store as Rust keystore service and wallet files
    participant Bot as Fixed bundled bidding bot
    participant DB as SQLite runtime state
    participant Market as RPC and OpenSea adapters

    User->>Admin: Review wallet assignment and bidding authorization
    Admin->>Rust: Start bot with non-secret authorization draft
    Rust->>Rust: Reserve lifecycle generation and resolve fixed recipient
    Rust->>Prompt: Open serialized native authorization and passphrase prompt
    User->>Prompt: Review exact bidding mandate and enter passphrase
    Prompt-->>Rust: Bounded prompt result over stdio
    Rust->>Rust: Revalidate generation, core health, frozen config, wallet assignment, and mandate
    Rust->>Store: Decrypt selected Ethereum keystore
    Store-->>Rust: Zeroizing private-key buffer
    Rust->>Rust: Verify decrypted identity and revalidate the frozen context after KDF work
    Rust->>Bot: Spawn recipient and attach process containment
    Rust->>Bot: Write one bounded secret-envelope v3 frame to stdin
    Rust->>Rust: Drop passphrase and key buffers; retain idle stdin writer
    Bot->>Bot: Validate frame, address, mandate, and config agreement
    Bot->>Bot: Build restricted signer and erase complete frame
    Bot->>Market: Reconcile allowance, snapshots, commands, and offers inside mandate
    Bot-->>Rust: Emit non-secret bootstrap, progress, and ready events
    Bot->>DB: Persist non-secret runtime heartbeat and job state

    alt Desktop parent closes stdin, stream errors, or extra bytes arrive
        Bot->>Bot: Exit fail closed
        Rust-->>Admin: Report bot error if the supervisor remains alive
    else Bot is explicitly stopped or its core generation ends
        Rust-->>Admin: Report stopped state
        Note over User,Admin: A later start requires a fresh native prompt
    end
```

## Secret Placement

The raw secret is permitted only in the native prompt, bounded Rust keystore
memory, the single stdin frame, and the live bot's restricted signer memory. It
must not enter WebView state, environment variables, CLI arguments, SQLite,
ordinary logs, or reusable unlock caches.

See [wallet custody and bot unlock](../desktop/03-wallet-keystore-and-bot-unlock.md)
and [bidding runtime bootstrap](../trading/01-bidding-runtime-and-jobs.md#runtime-bootstrap).
