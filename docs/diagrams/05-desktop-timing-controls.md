# Desktop Timing Controls

Canonical timing controls used across desktop startup/shutdown lifecycle.

| Area                               |      Value | Meaning                                                               |
| ---------------------------------- | ---------: | --------------------------------------------------------------------- |
| Tauri bridge wait timeout          |  `2_000ms` | Max wait to detect Tauri bridge before fataling startup.              |
| Tauri bridge poll interval         |     `50ms` | Poll cadence while waiting for bridge availability.                   |
| Lifecycle readiness poll interval  |    `300ms` | Poll cadence while waiting for runtime to report `running`.           |
| Lifecycle readiness timeout        | `30_000ms` | Fallback when no supervisor startup activity is available.            |
| Recovery work deadline             |    `15min` | One supervisor-enforced monotonic attempt; timeout initiates cleanup. |
| Service startup budget             |      `90s` | Both serial 30-second backend waits plus worker spawning allowance.   |
| Status request timeout             |  `2_000ms` | Bound each bridge status invocation.                                  |
| Status outage allowance            |  `5_000ms` | Fail readiness after no confirmed status for this duration.           |
| Phase reconciliation allowance     |  `5_000ms` | Allow the next supervisor phase/cleanup response to arrive.           |
| Backend readiness probe window     | `12_000ms` | Max retry window for first successful backend API response.           |
| Backend readiness retry delay      |    `250ms` | Delay between readiness probe retries.                                |
| Supervisor port wait timeout       |      `30s` | Max wait for critical startup ports to bind.                          |
| Supervisor semantic health timeout |      `30s` | Max wait for `GET /health/runtime` readiness gate.                    |
| Supervisor monitor poll interval   |    `500ms` | Poll cadence for unexpected child-process exits.                      |
| Supervisor startup wait poll       |    `150ms` | Poll cadence while ports and semantic health become ready.            |
| Process graceful stop wait         |      `30s` | Wait before force-killing processes during shutdown.                  |
| Bot start-signal timeout           |      `30s` | Max wait for a spawned bot to enter managed bootstrap.                |
| Bot secret-handoff timeout         |      `10s` | Max blocking time for the single stdin secret frame.                  |
| Bot bootstrap stall timeout        |     `180s` | Max interval without bot bootstrap progress.                          |

## Notes

- Startup waits and backoff periods are stop-signal cancellable.
- Runtime readiness for admin UI requires both process state and backend API probe success.
- Supervisor constants live in `src-tauri/src/runtime/supervisor.rs`; frontend
  lifecycle constants live in `frontend/src/lib/runtime/lifecycle/orchestrator.ts`.
