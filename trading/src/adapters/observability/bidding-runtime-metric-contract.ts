// Metric names are the stable Prometheus vocabulary shared by runtime instrumentation and dashboards.
export const BIDDING_RUNTIME_METRIC_NAME = {
    RuntimeState: "bidding_runtime_state",
    RuntimeBootstrapPhaseDuration:
        "bidding_runtime_bootstrap_phase_duration_ms",
    RuntimeTimeToReady: "bidding_runtime_time_to_ready_ms",
    RuntimeConfiguration: "bidding_runtime_configuration",
    Jobs: "bidding_jobs",
    JobScanDuration: "bidding_job_scan_duration_ms",
    JobScanSize: "bidding_job_scan_size",
    JobRefreshRequests: "bidding_job_refresh_requests_total",
    JobRefreshQueueWait: "bidding_job_refresh_queue_wait_ms",
    JobRefreshDuration: "bidding_job_refresh_duration_ms",
    JobRefreshActive: "bidding_job_refresh_active",
    JobRefreshWaiting: "bidding_job_refresh_waiting",
    JobRefreshPending: "bidding_job_refresh_pending",
    MarketActions: "bidding_market_actions_total",
    MarketActionDuration: "bidding_market_action_duration_ms",
    CommandReconciliationDuration: "bidding_command_reconciliation_duration_ms",
    CommandReconciliationBatchSize: "bidding_command_reconciliation_batch_size",
    CommandQueueWait: "bidding_command_queue_wait_ms",
    CommandClaimToStrategy: "bidding_command_claim_to_strategy_ms",
    CommandCreatedToStrategy: "bidding_command_created_to_strategy_ms",
    CommandProcessingDuration: "bidding_command_processing_duration_ms",
    Commands: "bidding_commands_total",
    CommandInFlight: "bidding_command_in_flight",
    StreamEvents: "bidding_stream_events_total",
    StreamEventAge: "bidding_stream_event_age_ms",
    StreamDispatchDuration: "bidding_stream_dispatch_duration_ms",
    StreamDispatchActive: "bidding_stream_dispatch_active",
    HotRefreshSignals: "bidding_hot_refresh_signals_total",
    HotRefreshPendingEvents: "bidding_hot_refresh_pending_events",
    HotRefreshPendingSignals: "bidding_hot_refresh_pending_signals",
    HotRefreshActiveLanes: "bidding_hot_refresh_active_lanes",
    HotRefreshKnownLanes: "bidding_hot_refresh_known_lanes",
    HotRefreshQueueWait: "bidding_hot_refresh_queue_wait_ms",
    HotRefreshPassDuration: "bidding_hot_refresh_pass_duration_ms",
    HotRefreshPassEvents: "bidding_hot_refresh_pass_events",
    HotRefreshPassSignals: "bidding_hot_refresh_pass_signals",
    SnapshotRefreshRequests: "bidding_snapshot_refresh_requests_total",
    SnapshotRefreshDuration: "bidding_snapshot_refresh_duration_ms",
    SnapshotRefreshPages: "bidding_snapshot_refresh_pages",
    SnapshotRefreshOffers: "bidding_snapshot_refresh_offers",
    SnapshotRefreshInFlight: "bidding_snapshot_refresh_in_flight",
    SnapshotRefreshPending: "bidding_snapshot_refresh_pending",
    SnapshotWatchedCollections: "bidding_snapshot_watched_collections",
    OpenSeaOperations: "bidding_opensea_operations_total",
    OpenSeaOperationDuration: "bidding_opensea_operation_duration_ms",
    OpenSeaRetries: "bidding_opensea_retries_total",
    OpenSeaRateLimitWait: "bidding_opensea_rate_limit_wait_ms",
    OpenSeaRateLimitQueueDepth: "bidding_opensea_rate_limit_queue_depth",
    BidBookProjectionRequests: "bidding_bid_book_projection_requests_total",
    BidBookProjectionQueueWait: "bidding_bid_book_projection_queue_wait_ms",
    BidBookProjectionDuration: "bidding_bid_book_projection_duration_ms",
    BidBookProjectionRows: "bidding_bid_book_projection_rows",
    BidBookProjectionActive: "bidding_bid_book_projection_active",
    BidBookProjectionPending: "bidding_bid_book_projection_pending",
} as const;

// Metric label names are the serialized Prometheus vocabulary used by dashboard queries.
export const BIDDING_RUNTIME_METRIC_LABEL = {
    Action: "action",
    CommandKind: "command_kind",
    DryRun: "dry_run",
    EventScope: "event_scope",
    EventType: "event_type",
    Lane: "lane",
    Operation: "operation",
    Outcome: "outcome",
    Phase: "phase",
    Priority: "priority",
    Result: "result",
    RuntimeState: "runtime_state",
    Setting: "setting",
    TargetType: "target_type",
    Trigger: "trigger",
} as const;

// Forbidden label names keep per-identity and free-text values out of bidding time series and dashboards.
export const BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS = Object.freeze([
    "address",
    "collection_id",
    "collection_slug",
    "command_id",
    "error",
    "job_id",
    "lane_key",
    "maker",
    "order_hash",
    "order_id",
    "reason",
    "token_id",
    "wallet_id",
]);

// Common result values keep success-rate queries consistent across metric families.
export const BIDDING_RUNTIME_METRIC_RESULT = {
    Success: "success",
    ExpectedAbsence: "expected_absence",
    Failure: "failure",
} as const;

// Unknown is used only when a bounded domain label is unavailable at an instrumentation boundary.
export const BIDDING_RUNTIME_UNKNOWN_LABEL = "unknown";

// OpenSea lanes identify the independently keyed and rate-limited API paths.
export const BIDDING_OPEN_SEA_LANE = {
    Bidding: "bidding",
    Snapshot: "snapshot",
} as const;

export type BiddingOpenSeaLane =
    (typeof BIDDING_OPEN_SEA_LANE)[keyof typeof BIDDING_OPEN_SEA_LANE];

// Aggregate target label represents the total job inventory across target types.
export const BIDDING_RUNTIME_TARGET_TYPE_AGGREGATE = "all";

// Runtime states cover the process lifecycle while the pull exporter remains available.
export const BIDDING_RUNTIME_METRIC_STATE = {
    Bootstrapping: "bootstrapping",
    Running: "running",
    ShuttingDown: "shutting_down",
} as const;

export type BiddingRuntimeMetricState =
    (typeof BIDDING_RUNTIME_METRIC_STATE)[keyof typeof BIDDING_RUNTIME_METRIC_STATE];

// Config-setting labels let dashboards compare live pressure with the configured limits and cadences.
export const BIDDING_RUNTIME_CONFIGURATION_SETTING = {
    MaxConcurrentJobs: "max_concurrent_jobs",
    ScanIntervalMs: "scan_interval_ms",
    CommandPollMs: "command_poll_ms",
    CommandBatchSize: "command_batch_size",
    SnapshotPollMs: "snapshot_poll_ms",
    SnapshotTtlMs: "snapshot_ttl_ms",
    HotRefreshBroadCooldownMs: "hot_refresh_broad_cooldown_ms",
    HotRefreshBroadMaxPending: "hot_refresh_broad_max_pending",
    HotRefreshItemCooldownMs: "hot_refresh_item_cooldown_ms",
    HotRefreshItemMaxPending: "hot_refresh_item_max_pending",
} as const;

// Short-duration buckets cover local queueing and fast API operations.
export const BIDDING_SHORT_DURATION_BUCKETS_MS = Object.freeze([
    0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
]);

// Queue-duration buckets preserve fast admission while exposing sustained waits up to one hour.
export const BIDDING_RUNTIME_QUEUE_DURATION_BUCKETS_MS = Object.freeze([
    0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
    60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
]);

// Long-duration buckets cover scans, snapshots, bootstrap, and shutdown work up to ten minutes.
export const BIDDING_LONG_DURATION_BUCKETS_MS = Object.freeze([
    0, 100, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000,
    600_000,
]);

// Durable-command queue buckets cover brief contention through a full day offline.
export const BIDDING_COMMAND_QUEUE_DURATION_BUCKETS_MS = Object.freeze([
    0, 100, 500, 1_000, 5_000, 30_000, 60_000, 300_000, 900_000, 1_800_000,
    3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
]);

// Event-age buckets surface stream lag from sub-second delivery through ten-minute backlog.
export const BIDDING_EVENT_AGE_BUCKETS_MS = Object.freeze([
    0, 100, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000,
    600_000,
]);

// Count buckets preserve empty work passes and cover coalesced batches without assuming one event.
export const BIDDING_COUNT_BUCKETS = Object.freeze([
    0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000,
]);

// Large-count buckets preserve empty results and cover multi-page snapshots and projection row sets.
export const BIDDING_LARGE_COUNT_BUCKETS = Object.freeze([
    0, 10, 100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
]);
