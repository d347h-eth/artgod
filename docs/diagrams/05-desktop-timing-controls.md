# Desktop Timing Controls

Canonical timing controls used across desktop startup/shutdown lifecycle.

| Area                               |      Value | Meaning                                                     |
| ---------------------------------- | ---------: | ----------------------------------------------------------- |
| Tauri bridge wait timeout          |  `2_000ms` | Max wait to detect Tauri bridge before fataling startup.    |
| Tauri bridge poll interval         |     `50ms` | Poll cadence while waiting for bridge availability.         |
| Lifecycle readiness poll interval  |    `300ms` | Poll cadence while waiting for runtime to report `running`. |
| Lifecycle readiness timeout        | `30_000ms` | Max wait for runtime to reach `running`.                    |
| Backend readiness probe window     | `12_000ms` | Max retry window for first successful backend API response. |
| Backend readiness retry delay      |    `250ms` | Delay between readiness probe retries.                      |
| Supervisor port wait timeout       |      `30s` | Max wait for critical startup ports to bind.                |
| Supervisor semantic health timeout |      `30s` | Max wait for `GET /health/runtime` readiness gate.          |
| Process graceful stop wait         |      `10s` | Wait before force-killing processes during shutdown.        |

## Notes

- Startup waits and backoff periods are stop-signal cancellable.
- Runtime readiness for admin UI requires both process state and backend API probe success.
