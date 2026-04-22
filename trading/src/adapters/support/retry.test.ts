import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { getRetryDelayMs, retry } from "./retry.js";

describe("retry", () => {
    it("retries until the function succeeds", async () => {
        const delays: number[] = [];
        let attempts = 0;

        const result = await retry(
            async () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error(`fail-${attempts}`);
                }
                return "ok";
            },
            {
                maxAttempts: 5,
                minDelayMs: 100,
                maxDelayMs: 1_000,
                factor: 2,
                jitterRatio: 0,
            },
            {
                sleepFn: async (ms) => {
                    delays.push(ms);
                },
            },
        );

        assert.equal(result, "ok");
        assert.equal(attempts, 3);
        assert.deepEqual(delays, [100, 200]);
    });

    it("stops retrying when shouldRetry returns false", async () => {
        let attempts = 0;

        await assert.rejects(
            () =>
                retry(
                    async () => {
                        attempts++;
                        throw new Error("stop");
                    },
                    {
                        maxAttempts: 5,
                        minDelayMs: 100,
                        maxDelayMs: 1_000,
                        factor: 2,
                        jitterRatio: 0,
                    },
                    {
                        shouldRetry: () => false,
                        sleepFn: async () => {},
                    },
                ),
            /stop/,
        );

        assert.equal(attempts, 1);
    });

    it("applies bounded jitter to the computed delay", () => {
        const min = getRetryDelayMs(
            2,
            {
                maxAttempts: 5,
                minDelayMs: 100,
                maxDelayMs: 1_000,
                factor: 2,
                jitterRatio: 0.1,
            },
            () => 0,
        );
        const max = getRetryDelayMs(
            2,
            {
                maxAttempts: 5,
                minDelayMs: 100,
                maxDelayMs: 1_000,
                factor: 2,
                jitterRatio: 0.1,
            },
            () => 1,
        );

        assert.equal(min, 180);
        assert.equal(max, 220);
    });
});
