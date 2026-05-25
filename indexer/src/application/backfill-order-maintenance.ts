import type { SyncRange } from "./sync.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    type BackfillOrderMaintenancePolicy,
} from "../domain/sync-jobs.js";

type WethMakerLogDecisionInput = {
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
    range: SyncRange;
    bidderIndexActive: boolean;
    hasCurrentStateProjection: boolean;
};

// True when a backfill policy allows maker-wide current order revalidation.
export function allowsGlobalMakerRevalidation(
    policy: BackfillOrderMaintenancePolicy,
): boolean {
    return policy === BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState;
}

// WETH logs only drive current-state order maintenance, never historical facts.
export function shouldFetchWethMakerLogs(
    input: WethMakerLogDecisionInput,
): boolean {
    if (!allowsGlobalMakerRevalidation(input.orderMaintenancePolicy)) {
        return false;
    }
    if (!input.bidderIndexActive) return false;
    if (input.range.fromBlock > input.range.toBlock) return false;
    return input.hasCurrentStateProjection;
}
