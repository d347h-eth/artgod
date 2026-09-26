/** A scheduling wait is not a failed execution and must not exhaust the DLQ budget. */
export class JobDeferred extends Error {
    constructor(
        message: string,
        readonly delayMs: number,
    ) {
        super(message);
    }
}
