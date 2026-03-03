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
    A->>A: Mount lifecycle tab immediately

    A->>T: Wait bridge, then invoke runtime_auto_start
    T->>R: runtime_auto_start
    R->>S: Start supervisor

    S->>W: Start NATS
    S->>B: Start backend
    S->>W: Start indexer workers
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
