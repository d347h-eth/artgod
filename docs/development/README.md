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
- [Production simulation workbench](06-deterministic-system-testing-strategy.md)
  defines the authorized production-runtime boundary, whole-machine replay,
  provider disagreement, oracle and implementation milestones.
- [Properties and scenarios](07-deterministic-system-testing-scenarios.md)
  defines deliberate distributed-system histories and required evidence.
- [Workbench execution](08-simulation-workbench-execution.md) covers explicit
  guest inputs, build, preflight, record/replay and qualification limits.
- [Qualification closure](09-simulation-qualification-closure.md) defines the
  five authorized follow-ups and evidence required for the simulation branch's
  merge review.

Remaining work is tracked in the [unified backlog](../planning/01-unified-backlog.md).
