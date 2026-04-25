import { biddingLog } from "../utils/bidding-log.js";
import type { BiddingJobCommandReconciler } from "../application/use-cases/bidding/bidding-job-command-reconciler.js";

export type BiddingCommandReconciliationLoopHandle = {
    shutdown(): Promise<void>;
};

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
                    const message =
                        error instanceof Error ? error.message : String(error);
                    biddingLog.warn(
                        `[BiddingCommandReconciliationLoop] Poll scan failed. error=${message}`,
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
