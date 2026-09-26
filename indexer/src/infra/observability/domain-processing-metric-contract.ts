/** Metric names/labels belong to this adapter; workflow outcomes remain application-owned. */
export const DOMAIN_PROCESSING_METRIC = {
    Operations: "processing_operations_total",
    Duration: "processing_duration_seconds",
    Active: "processing_active",
    DemandBatches: "order_demand_batches_total",
    DemandOrders: "order_demand_orders_total",
    DemandDuration: "order_demand_batch_duration_seconds",
    DemandSampledAge: "order_demand_sampled_age_seconds",
    MakerCheckpoints: "order_maker_checkpoints_total",
    MakerOrders: "order_maker_checkpoint_orders_total",
    ContractReads: "order_validation_contract_reads_total",
    AdmissionActive: "order_validation_active",
    AdmissionWaiting: "order_validation_waiting",
    AdmissionCapacity: "order_validation_capacity",
    AdmissionWait: "order_validation_wait_seconds",
    Recovery: "order_maker_recovery_total",
    ReceiptsCleaned: "order_maker_receipts_cleaned_total",
    OutboxPublications: "queue_outbox_publications_total",
} as const;

export const DOMAIN_PROCESSING_METRIC_LABEL = {
    Operation: "operation",
    Result: "result",
    Outcome: "outcome",
    Path: "path",
    Kind: "kind",
    End: "end",
    Queue: "queue",
    Status: "status",
} as const;

export const DOMAIN_PROCESSING_RESULT = {
    Success: "success",
    Failure: "failure",
    Granted: "granted",
    Cancelled: "cancelled",
} as const;

export const MAKER_CHECKPOINT_OUTCOME = {
    Resolved: "resolved",
    Deferred: "deferred",
    Validated: "validated",
} as const;
export const MAKER_CHECKPOINT_COUNTERS = Object.values(
    MAKER_CHECKPOINT_OUTCOME,
);
export const VALIDATION_READ_COUNTERS = [
    "perOrder",
    "shared",
    "other",
    "statusBatches",
] as const;
export const MAKER_RECOVERY_OUTCOME = {
    Checked: "checked",
    Recovered: "recovered",
    Failed: "failed",
} as const;

// Explicit seconds buckets: the shared exporter's default buckets are milliseconds.
export const PROCESSING_DURATION_BUCKETS_SECONDS = [
    0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
] as const;
// Sampled requirement age can span days after an app has been offline.
export const DEMAND_AGE_BUCKETS_SECONDS = [
    1, 5, 30, 60, 300, 900, 3600, 21600, 86400, 259200, 604800,
] as const;
