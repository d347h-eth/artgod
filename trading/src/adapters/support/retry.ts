import { sleep } from "../../utils/sleep.js";

export type RetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
};

export type RetryContext = {
    attempt: number;
    delayMs: number;
    error: unknown;
};

export type RetryOptions = {
    onRetry?: (context: RetryContext) => void;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    sleepFn?: (ms: number) => Promise<void>;
    randomFn?: () => number;
};

export const defaultRetryPolicy: RetryPolicy = {
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.2,
};

const RETRY_EXPONENTIAL_FACTOR = 2;

// Retries transient adapter work with bounded exponential backoff and optional jitter.
export async function retry<T>(
    fn: () => Promise<T>,
    policy: RetryPolicy = defaultRetryPolicy,
    options: RetryOptions = {},
): Promise<T> {
    const sleepFn = options.sleepFn ?? sleep;
    const randomFn = options.randomFn ?? Math.random;

    let attempt = 0;
    let lastError: unknown;

    while (attempt < policy.maxAttempts) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            attempt += 1;

            if (attempt >= policy.maxAttempts) {
                break;
            }

            if (options.shouldRetry && !options.shouldRetry(error, attempt)) {
                break;
            }

            const delayMs = getRetryDelayMs(attempt, policy, randomFn);
            options.onRetry?.({
                attempt,
                delayMs,
                error,
            });
            await sleepFn(delayMs);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getRetryDelayMs(
    attempt: number,
    policy: RetryPolicy = defaultRetryPolicy,
    randomFn: () => number = Math.random,
): number {
    const exponent = Math.max(0, attempt - 1);
    const baseDelay = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * Math.pow(RETRY_EXPONENTIAL_FACTOR, exponent),
    );
    const jitter =
        baseDelay * policy.jitterRatio * (randomFn() * 2 - 1);
    return Math.max(0, Math.round(baseDelay + jitter));
}
