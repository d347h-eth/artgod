import { strict as assert } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import {
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY,
    TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME,
    TokenBucketRateLimiter,
} from "./token-bucket-rate-limiter.js";

describe("TokenBucketRateLimiter", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("allows requests immediately while tokens are available", async () => {
        let now = 0;
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 2,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
        );

        await limiter.wait(1, 0);
        await limiter.wait(1, 0);
    });

    it("keeps immediate admission independent from throwing observers", async () => {
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => 0,
            {
                onRateLimitQueueDepthChanged: () => {
                    throw new Error("queue observer failed");
                },
                onRateLimitWaitFinished: () => {
                    throw new Error("wait observer failed");
                },
            },
        );

        await limiter.wait(1, 0);
    });

    it("still schedules queued work when its admission observer throws", async () => {
        vi.useFakeTimers();
        let now = 0;
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
            {
                onRateLimitQueueDepthChanged: () => {
                    throw new Error("queue observer failed");
                },
                onRateLimitWaitFinished: () => undefined,
            },
        );

        await limiter.wait(1, 0);
        const queuedWait = limiter.wait(1, 0);

        now = 1_000;
        await vi.advanceTimersByTimeAsync(1_000);

        await queuedWait;
    });

    it("resolves drained work when its completion observer throws", async () => {
        vi.useFakeTimers();
        let now = 0;
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
            {
                onRateLimitQueueDepthChanged: () => undefined,
                onRateLimitWaitFinished: ({ outcome }) => {
                    if (
                        outcome === TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME.Queued
                    ) {
                        throw new Error("wait observer failed");
                    }
                },
            },
        );

        await limiter.wait(1, 0);
        const queuedWait = limiter.wait(1, 0);

        now = 1_000;
        await vi.advanceTimersByTimeAsync(1_000);

        await queuedWait;
    });

    it("waits until GET tokens refill when budget is exhausted", async () => {
        vi.useFakeTimers();
        let now = 0;
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 2,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
        );

        await limiter.wait(1, 0);
        let resolved = false;
        const waitPromise = limiter.wait(1, 0).then(() => {
            resolved = true;
        });
        await vi.advanceTimersByTimeAsync(499);

        assert.equal(resolved, false);

        now = 500;
        await vi.advanceTimersByTimeAsync(1);
        await waitPromise;

        assert.equal(resolved, true);
    });

    it("waits for the slower of the GET and POST deficits", async () => {
        vi.useFakeTimers();
        let now = 0;
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 4,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
        );

        await limiter.wait(1, 1);
        let resolved = false;
        const waitPromise = limiter.wait(1, 1).then(() => {
            resolved = true;
        });

        now = 999;
        await vi.advanceTimersByTimeAsync(999);
        assert.equal(resolved, false);

        now = 1000;
        await vi.advanceTimersByTimeAsync(1);
        await waitPromise;

        assert.equal(resolved, true);
    });

    it("serves user command requests before background requests", async () => {
        vi.useFakeTimers();
        let now = 0;
        const queueDepths: number[] = [];
        const waits: Array<{
            priority: number;
            waitMs: number;
            outcome: string;
        }> = [];
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
            {
                onRateLimitQueueDepthChanged: (count) =>
                    queueDepths.push(count),
                onRateLimitWaitFinished: (input) => waits.push(input),
            },
        );
        const completed: string[] = [];

        await limiter.wait(1, 0);
        void limiter.wait(1, 0).then(() => completed.push("background"));
        void limiter
            .wait(1, 0, {
                priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand,
            })
            .then(() => completed.push("command"));

        now = 1000;
        await vi.advanceTimersByTimeAsync(1000);
        assert.deepEqual(completed, ["command"]);

        now = 2000;
        await vi.advanceTimersByTimeAsync(1000);

        assert.deepEqual(completed, ["command", "background"]);
        assert.deepEqual(queueDepths, [0, 1, 2, 1, 0]);
        assert.deepEqual(waits, [
            {
                priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
                waitMs: 0,
                outcome: TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME.Immediate,
            },
            {
                priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand,
                waitMs: 1_000,
                outcome: TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME.Queued,
            },
            {
                priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
                waitMs: 2_000,
                outcome: TOKEN_BUCKET_RATE_LIMIT_WAIT_OUTCOME.Queued,
            },
        ]);
    });
});
