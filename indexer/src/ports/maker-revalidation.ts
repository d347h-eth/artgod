import type { OrderUpdateByMakerPayload } from "../domain/order-jobs.js";
import type {
    MakerPassBoundary,
    MakerRevalidationRun,
    MakerValidationCandidate,
    MakerValidationResolution,
    MakerWakeup,
} from "../domain/maker-revalidation.js";
import type { QueueDeliveryOrigin, QueueReplayBoundary } from "./queue.js";

/** Domain projection behavior used inside the checkpoint adapter's write transaction. */
export interface MakerOrderProjectionPort {
    captureMakerPass(): MakerPassBoundary;
    selectMakerCandidates(
        payload: OrderUpdateByMakerPayload,
        afterId: string,
        boundary: MakerPassBoundary,
        limit: number,
    ): MakerValidationCandidate[];
    applyMakerResolution(
        payload: OrderUpdateByMakerPayload,
        resolution: MakerValidationResolution,
    ): void;
}

export interface MakerRevalidationStore {
    admit(input: {
        jobId: string;
        payload: OrderUpdateByMakerPayload;
        origin?: QueueDeliveryOrigin;
        now: number;
    }): MakerRevalidationRun;
    claim(
        runId: string,
        owner: string,
        now: number,
    ): MakerRevalidationRun | null;
    resume(input: {
        chainId: number;
        runId: string;
        step: number;
        origin?: QueueDeliveryOrigin;
    }): MakerRevalidationRun | null;
    next(run: MakerRevalidationRun, limit: number): MakerValidationCandidate[];
    /** Effects and cursor/terminal transition must commit atomically, guarded by the lease fence. */
    checkpoint(
        run: MakerRevalidationRun,
        resolutions: MakerValidationResolution[],
        complete: boolean,
        now: number,
    ): MakerRevalidationRun;
    renew(run: MakerRevalidationRun, now: number): boolean;
    release(run: MakerRevalidationRun, now: number, error?: unknown): void;
    cleanup(boundary: QueueReplayBoundary, limit: number): number;
    listWakeups(now: number, limit: number): MakerWakeup[];
    recoverWakeup(wakeup: MakerWakeup, now: number): boolean;
}
