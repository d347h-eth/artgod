import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { TokenBucketRateLimiter } from "./token-bucket-rate-limiter.js";

describe("TokenBucketRateLimiter", () => {
    it("allows requests immediately while tokens are available", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 2,
                getRefillPerSecond: 1,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
            async (ms) => {
                waits.push(ms);
                now += ms;
            },
        );

        await limiter.wait(1, 0);
        await limiter.wait(1, 0);

        assert.deepEqual(waits, []);
    });

    it("waits until GET tokens refill when budget is exhausted", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 2,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
            async (ms) => {
                waits.push(ms);
                now += ms;
            },
        );

        await limiter.wait(1, 0);
        await limiter.wait(1, 0);

        assert.deepEqual(waits, [500]);
    });

    it("waits for the slower of the GET and POST deficits", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new TokenBucketRateLimiter(
            {
                getMax: 1,
                getRefillPerSecond: 4,
                postMax: 1,
                postRefillPerSecond: 1,
            },
            () => now,
            async (ms) => {
                waits.push(ms);
                now += ms;
            },
        );

        await limiter.wait(1, 1);
        await limiter.wait(1, 1);

        assert.deepEqual(waits, [1000]);
    });
});
