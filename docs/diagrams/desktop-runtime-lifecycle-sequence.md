# Desktop Runtime Lifecycle Sequence

This diagram shows the current desktop startup, readiness gating, backend API request flow, restart loop, and graceful shutdown behavior.

Runtime context:

- `src-tauri/*` runs in the native Rust desktop process.
- `frontend/src/lib/runtime/lifecycle/*` and `frontend/src/lib/backend-api.ts` run in the Tauri WebView JavaScript runtime (browser context).
- `backend` and all `indexer` workers run as separate child Node.js processes managed by the Rust supervisor.

## Startup + Readiness + API Request

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant WV as Tauri WebView (Svelte UI)
    participant O as DesktopLifecycleOverlay.svelte
    participant DS as desktop-runtime-store.ts + lifecycle/orchestrator.ts
    participant IL as initial-load.ts
    participant BA as backend-api.ts
    participant BO as backend-origin.ts
    participant TJ as Tauri JS Bridge (@tauri-apps/api)
    participant RT as Rust App (src-tauri/lib.rs)
    participant RM as RuntimeManager (supervisor.rs)
    participant SP as Supervisor Thread
    participant N as NATS Process
    participant B as Backend API Process (Node)
    participant IW as Indexer Workers (Node)

    U->>RT: Launch desktop app
    RT->>RT: setup() initializes commands + logs startup
    Note over RT: auto-start is deferred until frontend handshake

    WV->>O: Mount root layout immediately
    O->>DS: init()
    DS->>DS: begin boot lifecycle session
    DS->>TJ: wait for bridge (poll 50ms, timeout 2s)
    DS->>TJ: invoke runtime_auto_start()
    TJ->>RT: runtime_auto_start command
    RT->>RM: auto_start()
    RM->>RM: load_or_create desktop env/config
    RM->>RM: set status=starting
    RM->>SP: spawn run_supervisor_loop()
    DS->>TJ: invoke runtime_status/preflight/config/logs/listLogProcesses
    DS->>TJ: listen runtime-state-changed (always-on)

    loop supervisor startup loop
        SP->>SP: spawn nats process
        SP->>N: nats-server -js -p <port>
        SP->>SP: wait_for_port(nats, 30s)

        SP->>B: spawn backend/dist-desktop/server.mjs
        SP->>SP: wait_for_port(backend, 30s)

        SP->>IW: spawn all indexer worker artifacts
        SP->>B: probe GET /health/runtime (timeout 30s)
        alt health check passes (ok=true or warn-only checks)
            SP->>RM: update status=running + running_processes
            RM-->>TJ: emit runtime-state-changed
        else health check times out/fails
            SP->>SP: stop_all_processes()
            SP->>RM: update status=restarting + last_error
            RM-->>TJ: emit runtime-state-changed
            SP->>SP: sleep(restart_backoff_ms)
        end

        alt any managed process exits unexpectedly
            SP->>SP: stop_all_processes()
            SP->>RM: update status=restarting + last_error
            RM-->>TJ: emit runtime-state-changed
            SP->>SP: sleep(restart_backoff_ms)
        else stop requested
            SP->>SP: stop_all_processes()
            SP->>RM: update status=stopped
            RM-->>TJ: emit runtime-state-changed
        end
    end

    WV->>IL: initial root `/` collections route load check (desktop initial-load guard)
    IL->>TJ: quick invoke runtime_status (timeout 250ms)
    alt runtime not running yet
        IL-->>WV: defer backend fetch for initial route payload
        WV->>DS: waitUntilReady(30_000ms)
        WV->>WV: invalidateAll() after ready to re-run route load
    else runtime already running
        IL-->>WV: continue normal load
    end

    DS->>BO: resolveBackendOrigin()
    BO->>TJ: invoke runtime_get_endpoints
    TJ-->>BO: backendHttpBaseUrl
    BO-->>DS: backend origin

    loop backend readiness probe window (12_000ms, 250ms delay)
        DS->>B: fetch /api/chains/default
        alt HTTP 2xx
            B-->>DS: JSON payload
            DS-->>WV: lifecycle phase -> ready
            WV-->>O: overlay hidden
        else HTTP 500/502/503/504
            DS->>DS: sleep(250ms), retry
        else non-retryable error or timeout
            DS-->>WV: lifecycle phase -> fatal
        end
    end

    WV->>BA: requestJson(path)
    BA->>BO: resolveBackendOrigin()
    BO->>TJ: invoke runtime_get_endpoints
    TJ-->>BO: backendHttpBaseUrl
    BO-->>BA: backend origin
    BA->>B: fetch /api/*
    B-->>BA: JSON payload
    BA-->>WV: data
```

## Window Close / Exit (Graceful Stop)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant WV as Tauri Window
    participant RT as Rust App (src-tauri/lib.rs)
    participant RM as RuntimeManager
    participant SP as Supervisor Thread
    participant P as Managed Processes (NATS/Backend/Workers)
    participant TJ as Tauri JS Bridge
    participant DS as desktop-runtime-store.ts

    U->>WV: Close window
    WV->>RT: CloseRequested event
    RT->>RT: prevent_close()
    RT->>RT: atomic shutdown guard (set once)

    RT->>RM: stop()
    RM->>RM: set status=stopping
    RM-->>TJ: emit runtime-state-changed
    TJ-->>DS: runtime-state-changed(stopping)

    RM->>SP: send stop signal
    SP->>P: SIGTERM all
    SP->>P: wait up to 10s each
    alt process still alive
        SP->>P: kill forcefully
    end

    SP->>RM: supervisor exits
    RM->>RM: set status=stopped
    RM-->>TJ: emit runtime-state-changed
    TJ-->>DS: runtime-state-changed(stopped)

    RT->>RT: app_handle.exit(0)

    Note over RT: ExitRequested path also calls stop(),
    Note over RT: but same atomic guard prevents duplicate shutdown work.
```

## Key Timing Controls

- Tauri bridge init wait timeout: `2_000ms`
- Tauri bridge init poll interval: `50ms`
- desktop initial-load quick runtime status timeout: `250ms`
- `waitUntilReady` poll interval: `300ms`
- `waitUntilReady` timeout: `30_000ms`
- lifecycle backend readiness probe window: `12_000ms`
- lifecycle backend readiness probe retry delay: `250ms`
- supervisor port wait timeout per critical process: `30s`
- supervisor semantic backend health timeout (`/health/runtime`): `30s`
- process graceful stop wait: `10s`
- supervisor startup waits/backoff are stop-signal cancellable
