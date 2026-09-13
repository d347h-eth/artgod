# Backend Hexagonal Request Flow

This diagram shows the runtime call flow for one backend request.
`backend/src/index.ts` wires outbound adapters and use cases, while
`backend/src/http-app.ts` wires inbound HTTP adapters and common hooks.

```mermaid
flowchart LR
    Client[Browser, CLI, or desktop client]
    Route[http-routes.ts<br/>method and path registration]
    Guard[HTTP boundary<br/>host, origin, CSRF, deployment scope]
    Adapter[Inbound HTTP adapter<br/>transport mapping]
    UseCase[Application use-case class<br/>business orchestration]
    Port[Application outbound port]
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
    Guard -. boundary rejection .-> Client
    UseCase -. typed domain or use-case failure .-> Errors
    Errors -. sanitized response .-> Client
    Route -. span metadata .-> Observe
```

## Dependency Rule

- Routes depend on inbound adapters, not concrete database or SDK adapters, and
  attach route-specific deployment guards and observability metadata.
- Inbound adapters translate transport data and call exported use-case methods.
- Use cases depend on domain types and application outbound port contracts.
- Concrete outbound adapters implement those ports and are wired one by one in
  `backend/src/index.ts`.
- Common HTTP code provides reusable query parsing, headers, security hooks,
  observability, and error mapping; route-specific parsing remains in inbound
  adapters.

See [API and application architecture](../backend/01-api-and-application-architecture.md)
and the [OpenAPI reference](../backend/openapi.yaml).
