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
- [Order reorg rollback investigation](05-order-reorg-rollback-investigation.md)
  preserves the October order-volume stress test, writer timeout, correctness
  constraints, and deferred reset/fencing designs.

Remaining work is tracked in the [unified backlog](../planning/01-unified-backlog.md).
