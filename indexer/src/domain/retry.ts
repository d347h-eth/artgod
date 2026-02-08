export type RetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
};

export const defaultRetryPolicy: RetryPolicy = {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 5 * 600,
};

export function getRetryDelayMs(
    attempt: number,
    policy: RetryPolicy = defaultRetryPolicy,
): number {
    const exp = Math.max(0, attempt - 1);
    const delay = policy.baseDelayMs * Math.pow(2, exp);
    return Math.min(delay, policy.maxDelayMs);
}
