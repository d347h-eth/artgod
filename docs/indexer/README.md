# Indexer Documentation

The indexer is the local event-ingestion and domain-projection subsystem. Read
the overview first, then follow the branch that owns the question.

## Orientation

1. [Overview](00-overview.md) — topology, invariants, runtime map, and major
   flows.
2. [Configuration](01-config-and-env.md) — typed runtime inputs and process
   requirements.
3. [Queues and jobs](02-queues-and-jobs.md) — durable work vocabulary,
   envelopes, retry, and dead-letter behavior.
4. [Ports and adapters](12-ports-and-adapters.md) — dependency direction and
   concrete boundaries.

## Runtime Flows

- [Scheduler](03-scheduler-worker.md)
- [Sync pipeline](04-sync-pipeline.md)
- [Reorg handling](06-reorg-handling.md)
- [Sequence diagrams](13-sequence-diagrams.md)
- [Collection bootstrap](14-collection-bootstrap.md)
- [Bootstrap execution and concurrency](17-bootstrap-execution-and-concurrency.md)

## Data and Domains

- [Storage and schema](05-storage-and-schema.md)
- [Orders and token sets](07-domain-orders.md)
- [Metadata and traits](08-domain-metadata.md)
- [Activities](09-domain-activities.md)
- [Fill decoding](15-fill-decoding.md)
- [Blockspace exploration](16-blockspace-exploration.md)

## Operations and Verification

- [Observability and metrics](10-observability-and-metrics.md)
- [Testing](11-testing.md)
- [Order queue recovery](18-order-queue-recovery.md)
- [Deferred order-processing cleanup](19-order-processing-cleanup.md) — removal
  inventory for a follow-up after queue healing; not current runtime behavior.
- [RPC interaction catalog](../rpc/01-http-rpc-interaction-catalog.md)
- [Backlog and status history](../planning/01-unified-backlog.md)
