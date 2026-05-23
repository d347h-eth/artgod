# Desktop Startup Happy Path

Boot sequence from app launch to runtime readiness.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Admin UI (WebView)
    participant T as Tauri JS Bridge
    participant R as Rust Runtime
    participant S as Supervisor
    participant B as Backend
    participant W as Indexer + NATS Stack

    U->>R: Launch app
    R->>R: Initialize tray + commands
    R->>A: Show admin window
    A->>A: Mount admin shell with no active tab

    A->>T: Wait bridge, then invoke runtime_auto_start
    T->>R: runtime_auto_start
    alt settings.json missing or autostart infra disabled
        R-->>A: status=stopped
        A->>A: Show config -> start infra -> userland actions
        U->>A: Boot defaults or saved settings
        A->>T: Save/render config, then runtime_start
        T->>R: runtime_start
        R->>S: Start supervisor
    else autostart infra enabled
        R->>S: Start supervisor
    end

    S->>W: Start NATS
    S->>B: Start backend
    S->>W: Start enabled indexer workers
    S->>B: Probe GET /health/runtime
    B-->>S: Semantic health ok
    S->>R: status=running + processes
    R-->>A: runtime-state-changed(running)

    loop readiness probe window
        A->>B: GET /api/chains/default
        alt success
            B-->>A: JSON payload
            A->>A: lifecycle phase = ready
        else transient startup error
            A->>A: retry after delay
        end
    end
```

## Result

- Runtime is running and semantically healthy.
- Admin lifecycle transitions to `ready`.
- Wallet-bound bot runtimes remain stopped/locked until the operator assigns a wallet and starts them explicitly.
