# Desktop Components Overview

High-level static composition of desktop runtime components and boundaries.

```mermaid
flowchart LR
    U[User]
    TW[Tauri Desktop App]
    AU[Admin UI<br/>Tauri WebView]
    TR[System Tray]
    RT[Rust Runtime Commands + Supervisor]
    KS[Rust Keystore Service]
    SP[Secret Prompt Helper<br/>Rust sidecar]
    NATS[NATS]
    BE[Backend HTTP]
    IDX[Indexer Workers]
    BOT[Trading Bot Runtimes]
    B[Userland Browser UI]
    DB[(SQLite)]
    WS[(Wallet Store<br/>app-data)]

    U --> TW
    TW --> AU
    TW --> TR
    TW --> RT

    AU --> RT
    TR --> RT
    RT --> KS
    KS --> SP
    KS --> WS

    RT --> NATS
    RT --> BE
    RT --> IDX
    RT --> BOT

    BE --> DB
    IDX --> DB
    IDX --> NATS
    BOT --> NATS
    BOT --> BE

    U --> B
    B --> BE
```

## Notes

- Admin UI is privileged through Tauri command bridge.
- Userland browser UI is unprivileged and accesses backend over localhost HTTP.
- Runtime process orchestration happens only in Rust supervisor.
- Raw secret entry/reveal happens only through the native secret-prompt sidecar, not in the WebView.
- Wallet material is stored separately from SQLite under desktop app-data.
