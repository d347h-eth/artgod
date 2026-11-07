# Development

- [Local development](01-local-development.md) covers setup, configuration,
  builds, and verification commands.
- [SQLite write contention](02-sqlite-write-contention.md) owns the shared
  retry policy, production write inventory, and remaining recovery decisions.
- [SQLite storage and recovery](03-sqlite-storage-and-recovery.md) defines what
  users keep and lose, permanent daily listings, startup recovery, ongoing
  maintenance and remaining release checks.
- [SQLite storage investigation](04-sqlite-wal-activities-storage-investigation.md)
  preserves the August–September measurements, data-use assessment, index
  analysis, recovery benchmarks and their limitations.
- [System testing discovery](05-deterministic-system-testing-discovery.md)
  inventories current sync, reorg, orderbook and CI coverage and reusable harnesses.
- [Proposed system testing strategy](06-deterministic-system-testing-strategy.md)
  compares tools and scopes deterministic execution, process acceptance, CI and
  staged implementation. This is a proposal, not an implemented framework.
- [Proposed properties and scenarios](07-deterministic-system-testing-scenarios.md)
  defines the bounded first journey and longer-term interaction coverage.

Remaining work is tracked in the [unified backlog](../planning/01-unified-backlog.md).
