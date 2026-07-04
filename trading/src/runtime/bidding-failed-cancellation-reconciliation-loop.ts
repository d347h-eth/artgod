import type { FailedOfferCancellationReconciler } from "../application/use-cases/bidding/failed-offer-cancellation-reconciler.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../utils/bidding-log.js";

export type BiddingFailedCancellationReconciliationLoopHandle = {
    shutdown(): Promise<void>;
};

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingFailedCancellationReconciler,
);

// Log actions owned by the failed-cancellation reconciliation scheduler.
const FAILED_CANCELLATION_RECONCILIATION_LOOP_LOG_ACTION = {
    Completed: "failedCancellationReconciliationCompleted",
    Failed: "failedCancellationReconciliationFailed",
} as const;

// Starts a low-cadence audit for cancellations that previously failed but may now be gone on OpenSea.
export function startBiddingFailedCancellationReconciliationLoop(
    reconciler: FailedOfferCancellationReconciler,
    pollMs: number,
): BiddingFailedCancellationReconciliationLoopHandle {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> = Promise.resolve();

    const schedule = () => {
        if (stopped) {
            return;
        }
        timer = setTimeout(() => {
            inFlight = reconciler
                .reconcileFailedCancellations()
                .then((completedCount) => {
                    if (completedCount > 0) {
                        log.info(
                            FAILED_CANCELLATION_RECONCILIATION_LOOP_LOG_ACTION.Completed,
                            "Recovered failed offer cancellations",
                            { completedCount },
                        );
                    }
                })
                .catch((error: unknown) => {
                    log.warn(
                        FAILED_CANCELLATION_RECONCILIATION_LOOP_LOG_ACTION.Failed,
                        "Failed offer cancellation reconciliation loop failed",
                        toErrorLogFields(error),
                    );
                })
                .finally(schedule);
        }, pollMs);
    };

    schedule();

    return {
        shutdown: async () => {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            await inFlight.catch(() => undefined);
        },
    };
}
