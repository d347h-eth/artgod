import { describe, expect, it } from "vitest";
import {
    CircuitBreaker,
    CircuitOpenError,
    executeWithRpcRetry,
    TokenBucketRateLimiter,
} from "./rpc-resilience.js";

describe("TokenBucketRateLimiter", () => {
    it("returns immediate permits inside burst and waits after it is exhausted", async () => {
        let now = 1_000;
        const limiter = new TokenBucketRateLimiter(
            {
                requestsPerSecond: 2,
                burst: 2,
            },
            () => now,
            async (ms) => {
                now += ms;
            },
        );

        await expect(limiter.acquire()).resolves.toBe(0);
        await expect(limiter.acquire()).resolves.toBe(0);
        await expect(limiter.acquire()).resolves.toBe(500);
        expect(now).toBe(1_500);
    });

    it("serializes concurrent acquires through one queue", async () => {
        let now = 0;
        const limiter = new TokenBucketRateLimiter(
            {
                requestsPerSecond: 1,
                burst: 1,
            },
            () => now,
            async (ms) => {
                now += ms;
            },
        );

        await limiter.acquire(); // consume burst token
        const [firstWait, secondWait] = await Promise.all([
            limiter.acquire(),
            limiter.acquire(),
        ]);

        expect(firstWait).toBe(1_000);
        expect(secondWait).toBe(1_000);
        expect(now).toBe(2_000);
    });
});

describe("CircuitBreaker", () => {
    it("opens after threshold failures and rejects while open", async () => {
        let now = 0;
        const breaker = new CircuitBreaker(
            {
                failureThreshold: 2,
                openMs: 1_000,
                halfOpenMaxRequests: 1,
            },
            () => now,
        );

        await expect(
            breaker.execute(async () => {
                throw new Error("rpc-1");
            }),
        ).rejects.toThrow("rpc-1");
        await expect(
            breaker.execute(async () => {
                throw new Error("rpc-2");
            }),
        ).rejects.toThrow("rpc-2");
        await expect(breaker.execute(async () => "ok")).rejects.toBeInstanceOf(
            CircuitOpenError,
        );
    });

    it("moves to half-open after timeout and closes after successful probes", async () => {
        let now = 0;
        const breaker = new CircuitBreaker(
            {
                failureThreshold: 1,
                openMs: 1_000,
                halfOpenMaxRequests: 1,
            },
            () => now,
        );

        await expect(
            breaker.execute(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        await expect(
            breaker.execute(async () => "blocked"),
        ).rejects.toBeInstanceOf(CircuitOpenError);

        now += 1_000;
        await expect(breaker.execute(async () => "probe-ok")).resolves.toBe(
            "probe-ok",
        );
        await expect(breaker.execute(async () => "closed-ok")).resolves.toBe(
            "closed-ok",
        );
    });

    it("re-opens when a half-open probe fails", async () => {
        let now = 0;
        const breaker = new CircuitBreaker(
            {
                failureThreshold: 1,
                openMs: 1_000,
                halfOpenMaxRequests: 1,
            },
            () => now,
        );

        await expect(
            breaker.execute(async () => {
                throw new Error("initial-fail");
            }),
        ).rejects.toThrow("initial-fail");

        now += 1_000;
        await expect(
            breaker.execute(async () => {
                throw new Error("probe-fail");
            }),
        ).rejects.toThrow("probe-fail");
        await expect(
            breaker.execute(async () => "blocked"),
        ).rejects.toBeInstanceOf(CircuitOpenError);
    });
});

describe("executeWithRpcRetry", () => {
    it("runs retry attempts with bounded backoff", async () => {
        const scheduled: Array<{
            attempt: number;
            nextAttempt: number;
            delayMs: number;
        }> = [];
        const sleeps: number[] = [];
        let attempts = 0;

        const result = await executeWithRpcRetry({
            policy: {
                maxAttempts: 3,
                baseDelayMs: 100,
                maxDelayMs: 150,
            },
            executeAttempt: async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new Error("temporary rpc failure");
                }
                return "ok";
            },
            onRetryScheduled: ({ attempt, nextAttempt, delayMs }) => {
                scheduled.push({ attempt, nextAttempt, delayMs });
            },
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });

        expect(result).toBe("ok");
        expect(attempts).toBe(3);
        expect(scheduled).toEqual([
            { attempt: 1, nextAttempt: 2, delayMs: 100 },
            { attempt: 2, nextAttempt: 3, delayMs: 150 },
        ]);
        expect(sleeps).toEqual([100, 150]);
    });
});
