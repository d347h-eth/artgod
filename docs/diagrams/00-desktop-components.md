# Desktop Components Overview

High-level static composition of desktop runtime components and boundaries.

```mermaid
flowchart LR
    U[User]
    TW[Tauri Desktop App]
    AU[Admin UI<br/>Tauri WebView]
    TR[System Tray]
    RT[Rust Runtime Commands + Supervisor]
    NATS[NATS]
    BE[Backend HTTP]
    IDX[Indexer Workers]
    B[Userland Browser UI]
    DB[(SQLite)]

    U --> TW
    TW --> AU
    TW --> TR
    TW --> RT

    AU --> RT
    TR --> RT

    RT --> NATS
    RT --> BE
    RT --> IDX

    BE --> DB
    IDX --> DB
    IDX --> NATS

    U --> B
    B --> BE
```

## Notes

- Admin UI is privileged through Tauri command bridge.
- Userland browser UI is unprivileged and accesses backend over localhost HTTP.
- Runtime process orchestration happens only in Rust supervisor.
