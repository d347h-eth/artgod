# Hosted Read-Only Topology

The hosted deployment is a self-operated, fixed-collection read surface. Only
the reverse proxy is public; application and data services remain on Docker
networks.

```mermaid
flowchart TB
    Visitor[Public browser]
    Proxy[Existing or bundled Caddy<br/>ports 80 and 443]

    subgraph Edge[public-edge network]
        Frontend[frontend-web<br/>SvelteKit SSR :42700]
        Backend[backend<br/>public_single_collection :42710]
    end

    subgraph Internal[private compose network]
        NATS[NATS JetStream :42720]
        Workers[Indexer and bootstrap workers]
        DB[(SQLite volume)]
        Media[(Token image-cache volume)]
    end

    subgraph RpcNet[ethereum-rpc network]
        RPC[Operator Ethereum node<br/>HTTP :8545 / WS :8546]
    end

    subgraph PrivateOps[private observability bind]
        Grafana[Grafana :42735]
        Telemetry[Loki, Prometheus, Tempo,<br/>Pyroscope, and Alloy]
    end

    OpenSea[OpenSea APIs]
    Metadata[Metadata HTTP and IPFS]

    Visitor --> Proxy
    Proxy -->|all page routes| Frontend
    Proxy -->|/api/* and /health/*| Backend
    Frontend -->|INTERNAL_BACKEND_ORIGIN| Backend

    Backend --> DB
    Backend --> Media
    Backend --> RPC
    NATS --> Workers
    Workers --> NATS
    Workers --> DB
    Workers --> Media
    Workers --> RPC
    Workers --> OpenSea
    Workers --> Metadata

    Backend -. metrics and traces .-> Telemetry
    Workers -. logs, metrics, traces, profiles .-> Telemetry
    Telemetry --> Grafana
```

## Exposure Contract

- `frontend-web`, `backend`, NATS, SQLite, and worker services have no permanent
  host port publication in the default deploy composition.
- Public mode registers only read routes for the configured chain and
  collection. It omits collection listing, bootstrap, customization mutations,
  trading mutations, and CSRF issuance.
- The frontend server uses `INTERNAL_BACKEND_ORIGIN` for SSR. Browser API reads
  use the public same-origin proxy path.
- Grafana is published only on the explicitly configured private host address;
  it does not join `public-edge`.

See the [hosted deployment runbook](../deploy/01-web-hosted-read-only.md) and
[HTTP security modes](../backend/02-http-security-and-deployment-modes.md).
