import type { SyncWorkClass } from "@artgod/shared/types/sync-work-class";
/** Shared admission covers validation and its short result transaction, never a whole maker pass. */
export interface OrderValidationAdmissionPort {
    /** Aborting cancels a queued admission; admitted work retains its permit until settled. */
    run<T>(
        work: () => Promise<T>,
        signal?: AbortSignal,
        workClass?: SyncWorkClass,
    ): Promise<T>;
}
/** In-memory capacity observations; no queue or database scans are needed. */
export interface OrderValidationAdmissionObserver {
    admissionState(active: number, waiting: number, capacity: number): void;
    admissionWait(durationMs: number, cancelled: boolean): void;
}
