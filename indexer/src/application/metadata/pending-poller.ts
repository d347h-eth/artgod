import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import { logger } from "@artgod/shared/utils";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    METADATA_PENDING_POLICY as POLICY,
    METADATA_PENDING_LOG as LOG,
    METADATA_PENDING_METRIC as METRIC,
    type MetadataAttempt,
} from "../../domain/metadata-pending.js";
import type { MetadataUpdatedToken } from "../../domain/metadata.js";
import type { MetadataDomain } from "./domain.js";

/** Small direct consumers of SQLite intent. Pending tokens never become retry broker messages. */
export function startMetadataPendingPoller(input: {
    chainId: number;
    metadata: Pick<MetadataDomain, "retryPending" | "pendingSummary">;
    workScope: { run<T>(workClass: SyncWorkClass, task: () => T): T };
    afterWrite(updated: MetadataUpdatedToken, attempt: MetadataAttempt): void;
    metrics?: Metrics;
}): () => Promise<void> {
    let stopped = false;
    const waits = new Set<() => void>();
    let lastMetricsAt = 0;
    const pause = () =>
        new Promise<void>((resolve) => {
            const resume = () => {
                clearTimeout(timer);
                waits.delete(resume);
                resolve();
            };
            const timer = setTimeout(resume, POLICY.pollMs);
            timer.unref?.();
            waits.add(resume);
            if (stopped) resume();
        });
    const run = async () => {
        while (!stopped) {
            try {
                const attempt = await input.workScope.run(
                    SYNC_WORK_CLASS.GapRepair,
                    () =>
                        input.metadata.retryPending(
                            input.chainId,
                            input.afterWrite,
                        ),
                );
                if (attempt) {
                    input.metrics?.increment(METRIC.Attempts, 1);
                    logger.debug(LOG.Attempt, {
                        component: LOG.Component,
                        chainId: input.chainId,
                        collectionId: attempt.target.collectionId,
                        tokenId: attempt.target.tokenId,
                        attempts: attempt.attempts,
                    });
                }
                const now = Date.now();
                if (now - lastMetricsAt >= POLICY.renewMs) {
                    lastMetricsAt = now;
                    const summary = input.metadata.pendingSummary(
                        input.chainId,
                    );
                    input.metrics?.gauge(METRIC.Backlog, summary.pending);
                    input.metrics?.gauge(METRIC.Exhausted, summary.exhausted);
                    input.metrics?.gauge(METRIC.OldestAge, summary.oldestAgeMs);
                }
            } catch (error) {
                if (!stopped)
                    logger.warn(LOG.PollFailed, {
                        component: LOG.Component,
                        error: String(error),
                    });
            }
            // Always yield at the configured pace, including while a large backlog is due.
            if (!stopped) await pause();
        }
    };
    const active = Array.from({ length: POLICY.concurrency }, () => run());
    return async () => {
        stopped = true;
        for (const resume of waits) resume();
        await Promise.all(active);
    };
}
