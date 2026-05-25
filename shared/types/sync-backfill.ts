// Backfill source labels explain why a range sync job exists.
export const BACKFILL_SOURCE = {
    ManualHistorical: "manual_historical",
    ReorgRecovery: "reorg_recovery",
    BootstrapCatchup: "bootstrap_catchup",
    GapRepair: "gap_repair",
} as const;

export type BackfillSource =
    (typeof BACKFILL_SOURCE)[keyof typeof BACKFILL_SOURCE];

// Backfill order-maintenance policies select which current-state order work is emitted.
export const BACKFILL_ORDER_MAINTENANCE_POLICY = {
    CurrentState: "current_state",
    SkipGlobalMakerRevalidation: "skip_global_maker_revalidation",
} as const;

export type BackfillOrderMaintenancePolicy =
    (typeof BACKFILL_ORDER_MAINTENANCE_POLICY)[keyof typeof BACKFILL_ORDER_MAINTENANCE_POLICY];
