# Backend Hexagonal Request Flow

This diagram shows dependency direction for one backend request. The
composition root is the only layer that knows concrete adapters.

```mermaid
flowchart LR
    Client[Browser, CLI, or desktop client]
    Route[http-routes.ts<br/>method and path registration]
    Guard[HTTP boundary<br/>host, origin, CSRF, deployment scope]
    Adapter[Inbound HTTP adapter<br/>transport mapping]
    UseCase[Application use-case class<br/>business orchestration]
    Port[Use-case-owned outbound port]
    DBAdapter[SQLite or read-model adapter]
    QueueAdapter[JetStream command adapter]
    NetworkAdapter[RPC or marketplace adapter]
    DB[(SQLite)]
    NATS[(NATS JetStream)]
    Network[Public RPC or marketplace API]
    Errors[Common HTTP error mapping]
    Observe[Route observability]

    Client --> Route
    Route --> Guard
    Guard --> Adapter
    Adapter -->|core input| UseCase
    UseCase --> Port
    Port --> DBAdapter
    Port --> QueueAdapter
    Port --> NetworkAdapter
    DBAdapter --> DB
    QueueAdapter --> NATS
    NetworkAdapter --> Network

    Adapter -->|core output to response| Client
    Guard -. expected boundary failure .-> Errors
    UseCase -. typed domain or use-case failure .-> Errors
    Errors -. sanitized response .-> Client
    Route -. span metadata .-> Observe
```

## Dependency Rule

- Routes depend on inbound adapters, not concrete database or SDK adapters.
- Inbound adapters translate transport data and call exported use-case methods.
- Use cases depend on domain types and locally owned outbound ports.
- Concrete outbound adapters implement those ports and are wired one by one in
  `backend/src/index.ts`.
- Common HTTP code owns parsing, headers, and error mapping; it does not own
  business behavior.

See [API and application architecture](../backend/01-api-and-application-architecture.md)
and the [OpenAPI reference](../backend/openapi.yaml).
