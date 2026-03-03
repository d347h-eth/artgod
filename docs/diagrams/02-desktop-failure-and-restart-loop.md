# Desktop Failure and Restart Loop

Fail-fast restart behavior for startup and runtime failures.

```mermaid
sequenceDiagram
    autonumber
    participant S as Supervisor
    participant P as Managed Processes
    participant B as Backend Health
    participant R as Runtime Status
    participant A as Admin UI

    loop supervisor cycle
        S->>P: Spawn NATS + backend + workers
        alt startup health fails
            S->>P: Stop all processes
            S->>R: state=restarting, last_error=reason
            R-->>A: runtime-state-changed(restarting)
            S->>S: Sleep restart_backoff_ms
        else startup health passes
            S->>R: state=running
            R-->>A: runtime-state-changed(running)

            loop runtime monitor
                alt any process exits unexpectedly
                    S->>P: Stop all processes
                    S->>R: state=restarting, last_error=process exit
                    R-->>A: runtime-state-changed(restarting)
                    S->>S: Sleep restart_backoff_ms
                else explicit stop requested
                    S->>P: Graceful stop + force kill fallback
                    S->>R: state=stopped
                    R-->>A: runtime-state-changed(stopped)
                end
            end
        end
    end
```

## Result

- Any core runtime failure causes full-stack restart.
- Partial runtime operation is intentionally not allowed.
