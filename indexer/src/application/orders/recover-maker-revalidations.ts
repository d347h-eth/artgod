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

type MakerRecoveryDependencies = {
    store: MakerRevalidationStore;
    isPublicationPending(
        publication: QueuePublication,
        queueName: QueueName,
    ): Promise<boolean>;
    replayBoundaries(): Promise<QueueReplayBoundary[]>;
};

/** Checks execution evidence as well as outbox status; sent does not mean completed. */
export async function recoverMakerRevalidations(
    deps: MakerRecoveryDependencies,
    now = Date.now(),
): Promise<number> {
    let recovered = 0;
    for (const wakeup of deps.store.listWakeups(now, POLICY.recoveryRows)) {
        try {
            let needed =
                wakeup.outboxStatus === null ||
                wakeup.outboxStatus === QUEUE_OUTBOX_STATUS.FailedTerminal;
            if (wakeup.outboxStatus === QUEUE_OUTBOX_STATUS.Sent) {
                needed =
                    !wakeup.publication ||
                    !wakeup.queueName ||
                    !(await deps.isPublicationPending(
                        wakeup.publication,
                        wakeup.queueName,
                    ));
            }
            if (needed && deps.store.recoverWakeup(wakeup, now)) recovered++;
        } catch (error) {
            logger.warn("Maker continuation recovery check failed", {
                component: LOG.Component,
                runId: wakeup.run.runId,
                error: String(error),
            });
        }
    }
    for (const boundary of await deps.replayBoundaries())
        deps.store.cleanup(boundary, POLICY.cleanupRows);
    return recovered;
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
