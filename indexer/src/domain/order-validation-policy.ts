/** Bounds wallet-state reuse independently of SQLite's candidate page size. */
export const ORDER_VALIDATION_BATCH_POLICY = Object.freeze({
    maxOrders: 100,
    admissionBudgetMs: 5_000,
    snapshotLifetimeMs: 30_000,
    statusBatchRetryAfterMs: 60_000,
});
