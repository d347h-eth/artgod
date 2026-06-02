// Log context fields keep maker revalidation output searchable across workers.
export const ORDER_UPDATE_BY_MAKER_LOG_CONTEXT = {
    Component: "OrdersDomain",
    Action: "handleOrderUpdateByMaker",
} as const;

// Stable messages for the compact maker revalidation runtime report.
export const ORDER_UPDATE_BY_MAKER_LOG_MESSAGE = {
    LegacyValidationResult: "Orders update-by-maker validation result",
    Started: "Orders update-by-maker started",
    Progress: "Orders update-by-maker progress",
    Completed: "Orders update-by-maker completed",
    ValidationStillRunning: "Orders update-by-maker validation still running",
} as const;

// Timing and sample limits for long-running maker revalidation reporting.
export const ORDER_UPDATE_BY_MAKER_REPORTING_LIMIT = {
    ProgressLogIntervalMs: 10_000,
    SlowValidationLogIntervalMs: 10_000,
    SlowSampleLimit: 5,
} as const;

// Reporting buckets for nullable row attributes that are not domain states.
export const ORDER_UPDATE_BY_MAKER_REPORTING_BUCKET = {
    Unknown: "unknown",
} as const;
