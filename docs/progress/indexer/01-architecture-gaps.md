# Blueprint Gaps: Architecture Overview

This file lists items described in `docs/blueprint/01-architecture-overview.md` that are not fully implemented yet.

## Missing or Partial

- Domain entities for `Block`, `Transaction`, `Log`, `Token`, `Collection` are not modeled as explicit domain types. The current implementation persists blocks and logs but does not expose explicit domain entities.
- Inventory domain is implicit (balances stored in `nft_balances`) but there is no explicit inventory module or domain handler.
- Collection-level aggregation tasks (for example refresh collection stats or owner counts) are not implemented.
- Backpressure controls and queue depth based scaling are not present (only a fixed worker concurrency).
- There is no explicit use case layer for `SyncBlock`, `ProcessLog`, `BackfillRange` as standalone classes. The logic exists in functions but not as distinct use case objects.
