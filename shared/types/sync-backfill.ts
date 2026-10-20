// Backfill source labels identify the current broker entry points.
export const BACKFILL_SOURCE = {
    ManualHistorical: "manual_historical",
    BootstrapCatchup: "bootstrap_catchup",
} as const;

export type BackfillSource =
    (typeof BACKFILL_SOURCE)[keyof typeof BACKFILL_SOURCE];
