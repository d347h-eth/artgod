import { describe, expect, it } from "vitest";
import { NOOP_APM } from "@artgod/shared/observability/apm";
import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { ViemBackendRpcClient } from "./viem-backend-rpc.js";

const TEST_RETRY_POLICY = {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
};

const DISABLED_RATE_LIMIT_RESILIENCE: RpcEndpointResilienceConfig = {
    rateLimiter: {
        requestsPerSecond: 0,
        burst: 1,
    },
    circuitBreaker: {
        failureThreshold: 10,
        openMs: 1000,
        halfOpenMaxRequests: 1,
    },
};

describe("ViemBackendRpcClient", () => {
    it("retries failed reads through the next weighted endpoint", async () => {
        const attemptedUrls: string[] = [];
        const client = new ViemBackendRpcClient(
            [
                { url: "https://rpc-a.example", weight: 1 },
                { url: "https://rpc-b.example", weight: 1 },
            ],
            NOOP_APM,
            undefined,
            {
                retryPolicy: TEST_RETRY_POLICY,
                resilience: DISABLED_RATE_LIMIT_RESILIENCE,
                sleep: async () => {},
                createClient: (url) =>
                    ({
                        getBlockNumber: async () => {
                            attemptedUrls.push(url);
                            if (url === "https://rpc-a.example") {
                                throw new Error("rpc-a unavailable");
                            }
                            return 123n;
                        },
                    }) as ReturnType<typeof import("viem").createPublicClient>,
            },
        );

        await expect(client.getCurrentBlockNumber()).resolves.toBe(123);
        expect(attemptedUrls).toEqual([
            "https://rpc-a.example",
            "https://rpc-b.example",
        ]);
    });
});
