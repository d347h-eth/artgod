/** Shared admission covers validation and its short result transaction, never a whole maker pass. */
export interface OrderValidationAdmissionPort {
    /** Aborting cancels a queued admission; admitted work retains its permit until settled. */
    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
