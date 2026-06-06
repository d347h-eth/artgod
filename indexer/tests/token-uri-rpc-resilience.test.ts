import { describe, expect, it } from "vitest";
import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { ViemTokenUriResolver } from "../src/infra/metadata/viem-token-uri.js";

const TEST_RETRY_POLICY = {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_REQUEST_TIMEOUT_MS = 5_000;

const DISABLED_RATE_LIMIT_RESILIENCE: RpcEndpointResilienceConfig = {
    requestTimeoutMs: TEST_REQUEST_TIMEOUT_MS,
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

describe("ViemTokenUriResolver RPC resilience", () => {
    it("retries transient tokenURI failures through the next weighted endpoint", async () => {
        const attemptedUrls: string[] = [];
        const resolver = new ViemTokenUriResolver({
            endpoints: [
                { url: "https://rpc-a.example", weight: 1 },
                { url: "https://rpc-b.example", weight: 1 },
            ],
            retryPolicy: TEST_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            sleep: async () => {},
            createClient: (url) =>
                ({
                    readContract: async () => {
                        attemptedUrls.push(url);
                        if (url === "https://rpc-a.example") {
                            throw new Error("rpc-a unavailable");
                        }
                        return "ipfs://metadata";
                    },
                }) as ReturnType<typeof import("viem").createPublicClient>,
        });

        await expect(
            resolver.resolveTokenUri(
                "0x0000000000000000000000000000000000000001",
                "1",
                "erc721",
            ),
        ).resolves.toBe("ipfs://metadata");
        expect(attemptedUrls).toEqual([
            "https://rpc-a.example",
            "https://rpc-b.example",
        ]);
    });
});
