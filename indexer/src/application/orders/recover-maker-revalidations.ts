import { logger } from "@artgod/shared/utils";
import { setTimeout as delay } from "node:timers/promises";
import {
    MAKER_REVALIDATION_LOG as LOG,
    MAKER_REVALIDATION_POLICY as POLICY,
} from "../../domain/maker-revalidation.js";
import { QUEUE_OUTBOX_STATUS } from "../../domain/queue-outbox.js";
import type {
    QueuePublication,
    QueueReplayBoundary,
} from "../../domain/jobs.js";
import type { MakerRevalidationStore } from "../../ports/maker-revalidation.js";
import type { QueueName } from "../../domain/queues.js";
import {
    observeBestEffort,
    observeProcessing,
    observeSyncProcessing,
} from "../processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION as OPERATION,
    type OrderProcessingObservability,
} from "./observability.js";

type MakerRecoveryDependencies = {
    store: MakerRevalidationStore;
    isPublicationPending(
        publication: QueuePublication,
        queueName: QueueName,
    ): Promise<boolean>;
    replayBoundaries(): Promise<QueueReplayBoundary[]>;
    observability?: OrderProcessingObservability;
};

/** Checks execution evidence as well as outbox status; sent does not mean completed. */
export async function recoverMakerRevalidations(
    deps: MakerRecoveryDependencies,
    now = Date.now(),
): Promise<number> {
    const hooks = deps.observability;
    return observeProcessing(hooks, OPERATION.MakerRecovery, {}, async () => {
        let recovered = 0;
        let checked = 0;
        let failed = 0;
        try {
            for (const wakeup of deps.store.listWakeups(
                now,
                POLICY.recoveryRows,
            )) {
                checked++;
                try {
                    await observeProcessing(
                        hooks,
                        OPERATION.MakerWakeup,
                        {
                            chainId: wakeup.run.chainId,
                            runId: wakeup.run.runId,
                        },
                        async () => {
                            let needed =
                                wakeup.outboxStatus === null ||
                                wakeup.outboxStatus ===
                                    QUEUE_OUTBOX_STATUS.FailedTerminal;
                            if (
                                wakeup.outboxStatus === QUEUE_OUTBOX_STATUS.Sent
                            ) {
                                needed =
                                    !wakeup.publication ||
                                    !wakeup.queueName ||
                                    !(await deps.isPublicationPending(
                                        wakeup.publication,
                                        wakeup.queueName,
                                    ));
                            }
                            if (needed && deps.store.recoverWakeup(wakeup, now))
                                recovered++;
                        },
                    );
                } catch (error) {
                    failed++;
                    logger.warn("Maker continuation recovery check failed", {
                        component: LOG.Component,
                        runId: wakeup.run.runId,
                        error: String(error),
                    });
                }
            }
            for (const boundary of await deps.replayBoundaries()) {
                const cleaned = observeSyncProcessing(
                    hooks,
                    OPERATION.MakerCleanup,
                    {},
                    () => deps.store.cleanup(boundary, POLICY.cleanupRows),
                );
                observeBestEffort(() =>
                    hooks?.observer?.makerReceiptsCleaned(cleaned),
                );
            }
            return recovered;
        } finally {
            observeBestEffort(() =>
                hooks?.observer?.makerRecovery(checked, recovered, failed),
            );
        }
    });
}

export function startMakerRevalidationRecovery(
    deps: MakerRecoveryDependencies,
): () => Promise<void> {
    let stopped = false;
    let active: Promise<unknown> | undefined;
    const tick = () => {
        if (stopped || active) return;
        active = recoverMakerRevalidations(deps)
            .catch((error) => {
                logger.warn("Maker continuation recovery failed", {
                    component: LOG.Component,
                    error: String(error),
                });
            })
            .finally(() => {
                active = undefined;
            });
    };
    const timer = setInterval(tick, POLICY.recoveryPollMs);
    timer.unref?.();
    tick();
    return async () => {
        stopped = true;
        clearInterval(timer);
        while (active)
            await Promise.race([active, delay(POLICY.recoveryPollMs)]);
    };
}
