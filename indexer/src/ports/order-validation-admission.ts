/** Shared admission covers validation and its short result transaction, never a whole maker pass. */
export interface OrderValidationAdmissionPort {
    run<T>(work: () => Promise<T>): Promise<T>;
}
