import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../utils/bidding-log.js";
import type { BiddingJobCommandReconciler } from "../application/use-cases/bidding/bidding-job-command-reconciler.js";

export type BiddingCommandReconciliationLoopHandle = {
    shutdown(): Promise<void>;
};

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.BiddingCommandReconciliationLoop,
);

// Starts the periodic DB Outbox scan used to recover command wake-ups that were not published.
export function startBiddingCommandReconciliationLoop(
    reconciler: BiddingJobCommandReconciler,
    pollMs: number,
): BiddingCommandReconciliationLoopHandle {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> = Promise.resolve();

    const schedule = () => {
        if (stopped) {
            return;
        }
        timer = setTimeout(() => {
            inFlight = reconciler
                .processPendingCommands("poll")
                .then(() => undefined)
                .catch((error: unknown) => {
                    log.warn(
                        "pollScanFailed",
                        "Bidding command poll scan failed",
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
