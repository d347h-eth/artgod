import {
    type OpenSeaHttpRateLimiterConfig,
    type OpenSeaHttpRetryPolicy,
} from "../config/opensea-http.js";
import { logger } from "../utils/logger.js";

export type OpenSeaApiRetryOptions<T> = {
    component: string;
    action: string;
    retryPolicy: OpenSeaHttpRetryPolicy;
    call: () => Promise<T>;
    shouldRetry?: (error: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
};

// Token-bucket limiter shared by OpenSea REST adapters.
export class OpenSeaApiRateLimiter {
    private readonly getMax: number;
    private readonly postMax: number;
    private readonly getRefillPerMs: number;
    private readonly postRefillPerMs: number;
    private getTokens: number;
    private postTokens: number;
    private lastRefillAt: number;

    constructor(config: OpenSeaHttpRateLimiterConfig) {
        this.getMax = Math.max(1, config.getMax);
        this.postMax = Math.max(1, config.postMax);
        this.getRefillPerMs = Math.max(0, config.getRefillPerSecond) / 1000;
        this.postRefillPerMs = Math.max(0, config.postRefillPerSecond) / 1000;
        this.getTokens = this.getMax;
        this.postTokens = this.postMax;
        this.lastRefillAt = Date.now();
    }

    async wait(getCost: number, postCost: number): Promise<void> {
        if (getCost <= 0 && postCost <= 0) return;

        while (true) {
            this.refill();
            if (this.getTokens >= getCost && this.postTokens >= postCost) {
                this.getTokens -= getCost;
                this.postTokens -= postCost;
                return;
            }

            const neededGet = Math.max(0, getCost - this.getTokens);
            const neededPost = Math.max(0, postCost - this.postTokens);
            const getWait =
                neededGet === 0 || this.getRefillPerMs === 0
                    ? 0
                    : neededGet / this.getRefillPerMs;
            const postWait =
                neededPost === 0 || this.postRefillPerMs === 0
                    ? 0
                    : neededPost / this.postRefillPerMs;
            const waitMs = Math.max(getWait, postWait, 25);
            await sleepMs(Math.ceil(waitMs));
        }
    }

    private refill(): void {
        const now = Date.now();
        const delta = now - this.lastRefillAt;
        if (delta <= 0) return;

        this.getTokens = Math.min(
            this.getMax,
            this.getTokens + delta * this.getRefillPerMs,
        );
        this.postTokens = Math.min(
            this.postMax,
            this.postTokens + delta * this.postRefillPerMs,
        );
        this.lastRefillAt = now;
    }
}

// Retries OpenSea REST calls with bounded exponential backoff and jitter.
export async function retryOpenSeaApiCall<T>(
    options: OpenSeaApiRetryOptions<T>,
): Promise<T> {
    const sleep = options.sleep ?? sleepMs;
    const maxAttempts = Math.max(1, options.retryPolicy.maxAttempts);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
        try {
            return await options.call();
        } catch (error) {
            lastError = error;
            attempt += 1;
            if (
                attempt >= maxAttempts ||
                options.shouldRetry?.(error) === false
            ) {
                break;
            }
            const delayMs = getOpenSeaApiRetryDelayMs(
                attempt,
                options.retryPolicy,
            );
            logger.warn("OpenSea API call failed; retrying", {
                component: options.component,
                action: options.action,
                attempt,
                delayMs,
                error: String(error),
            });
            await sleep(delayMs);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Computes jittered bounded exponential backoff for OpenSea API retries.
export function getOpenSeaApiRetryDelayMs(
    attempt: number,
    policy: OpenSeaHttpRetryPolicy,
): number {
    const baseDelay = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
    );
    const jitter = baseDelay * policy.jitterRatio * (Math.random() * 2 - 1);
    return Math.max(0, baseDelay + jitter);
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
