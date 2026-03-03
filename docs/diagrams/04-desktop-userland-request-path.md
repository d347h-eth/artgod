# Userland Browser Request Path

Userland browser flow for static page load and API reads.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Admin UI / Tray Action
    participant BR as System Browser
    participant BE as Backend HTTP
    participant DB as SQLite

    U->>A: Trigger "open ArtGod in browser"
    A->>BR: Open http://127.0.0.1:<backend-port>

    BR->>BE: GET /
    BE-->>BR: userland static index/assets

    BR->>BE: GET /api/chains/default
    BE->>DB: Query read models
    DB-->>BE: rows
    BE-->>BR: JSON response

    BR->>BE: GET /api/:chain_ref/collections
    BE->>DB: Query read models
    DB-->>BE: rows
    BE-->>BR: JSON response
```

## Boundary

- Userland browser UI does not use Tauri command bridge.
- Privileged operations remain in admin/tray native surface.
