import type { OrderUpdateByMakerPayload } from "../domain/order-jobs.js";
import type {
    MakerPassBoundary,
    MakerRevalidationRun,
    MakerValidationCandidate,
    MakerWakeup,
} from "../domain/maker-revalidation.js";
import type { QueueDeliveryOrigin, QueueReplayBoundary } from "./queue.js";
import type { QueueName } from "../domain/queues.js";

/** Domain projection behavior used inside the checkpoint adapter's write transaction. */
export interface MakerOrderProjectionPort {
    captureMakerPass(): MakerPassBoundary;
    selectMakerCandidates(
        payload: OrderUpdateByMakerPayload,
        afterId: string,
        boundary: MakerPassBoundary,
        limit: number,
    ): MakerValidationCandidate[];
}

export interface MakerRevalidationStore {
    /** Hand off a background hint through the existing outbox before main validation. */
    scheduleWakeup(run: MakerRevalidationRun, now: number): void;
    admit(input: {
        jobId: string;
        payload: OrderUpdateByMakerPayload;
        origin?: QueueDeliveryOrigin;
        /** Stable source identity; absent defaults to the durable input job identity. */
        observationKey?: string;
        now: number;
    }): MakerRevalidationRun | null;
    claim(
        runId: string,
        owner: string,
        now: number,
    ): MakerRevalidationRun | null;
    resume(input: {
        chainId: number;
        runId: string;
        step: number;
        queueName: QueueName;
        origin: QueueDeliveryOrigin;
    }): MakerRevalidationRun | null;
    /** Expand one bounded page into ordinary demand and advance the cursor atomically.
     * Completion means durable accounting, never successful protocol validation. */
    expand(run: MakerRevalidationRun, now: number): MakerRevalidationRun;
    release(run: MakerRevalidationRun, now: number, error?: unknown): void;
    cleanup(boundary: QueueReplayBoundary, limit: number): number;
    listWakeups(now: number, limit: number): MakerWakeup[];
    recoverWakeup(wakeup: MakerWakeup, now: number): boolean;
}
