/** Unsupported work remains in its original durable queue for operator review. */
export class UnsupportedJob extends Error {}

export const UNSUPPORTED_JOB_POLICY = Object.freeze({ retryMs: 60_000 });
export const UNSUPPORTED_JOB_LOG = "Unsupported queue work retained";
