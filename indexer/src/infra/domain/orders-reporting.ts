import { logger } from "@artgod/shared/utils";
import { WindowedLogReporter } from "@artgod/shared/observability/log-reporting";
import type { OrderMutationObserver } from "../../application/orders/observability.js";
import { ORDER_UPDATE_REASON } from "../../domain/order-jobs.js";
import {
    ORDER_SOURCE_STATUS,
    type OrderSourceStatus,
} from "../../domain/orders.js";

export const ORDER_DOMAIN_LOG_COMPONENT = "OrdersDomain";
export const ORDER_MUTATION_LOG = {
    Progress: "Order mutation progress",
    Action: "order_mutation_progress",
} as const;
export const ORDER_MUTATION_REPORTING_BUCKET = {
    OtherReason: "other",
} as const;

function emptyProgress() {
    return {
        upserts: { processed: 0, changed: 0, unchanged: 0 },
        sourceUpdates: {
            processed: 0,
            changed: 0,
            unchanged: 0,
            statuses: Object.fromEntries(
                Object.values(ORDER_SOURCE_STATUS).map((status) => [status, 0]),
            ),
            reasons: Object.fromEntries([
                ...Object.values(ORDER_UPDATE_REASON).map((reason) => [
                    reason,
                    0,
                ]),
                [ORDER_MUTATION_REPORTING_BUCKET.OtherReason, 0],
            ]),
        },
    };
}

/** Fixed counters per chain worker, without retaining order IDs or arbitrary reasons. */
export class OrderMutationProgress implements OrderMutationObserver {
    private readonly progress: WindowedLogReporter<
        ReturnType<typeof emptyProgress>
    >;

    constructor(chainId: number, now: () => number = Date.now) {
        this.progress = new WindowedLogReporter(
            emptyProgress,
            (counts, window) => {
                logger.info(ORDER_MUTATION_LOG.Progress, {
                    component: ORDER_DOMAIN_LOG_COMPONENT,
                    action: ORDER_MUTATION_LOG.Action,
                    chainId,
                    ...window,
                    ...counts,
                });
            },
            now,
        );
    }

    upserted(changed: boolean): void {
        this.progress.record((counts) => {
            counts.upserts.processed++;
            if (changed) counts.upserts.changed++;
            else counts.upserts.unchanged++;
        });
    }

    sourceUpdated(
        changed: boolean,
        status: OrderSourceStatus,
        reason: string,
    ): void {
        this.progress.record((counts) => {
            const updates = counts.sourceUpdates;
            updates.processed++;
            if (changed) updates.changed++;
            else updates.unchanged++;
            const statusBucket = Object.hasOwn(updates.statuses, status)
                ? status
                : ORDER_SOURCE_STATUS.Unknown;
            updates.statuses[statusBucket]++;
            const bucket = Object.hasOwn(updates.reasons, reason)
                ? reason
                : ORDER_MUTATION_REPORTING_BUCKET.OtherReason;
            updates.reasons[bucket]++;
        });
    }
}
