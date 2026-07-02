import { strict as assert } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import {
    TOKEN_BUCKET_RATE_LIMIT_PRIORITY,
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
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
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
    });
});
