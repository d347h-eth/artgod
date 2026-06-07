import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type TokenUriRpcClientFactory,
    ViemTokenUriResolver,
} from "../src/infra/metadata/viem-token-uri.js";

const TEST_RETRY_POLICY = {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_SINGLE_ATTEMPT_RETRY_POLICY = {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_REQUEST_TIMEOUT_MS = 5_000;
const TEST_RPC_ENDPOINT_A_URL = "https://rpc-a.example";
const TEST_RPC_ENDPOINT_B_URL = "https://rpc-b.example";
const TEST_RPC_ENDPOINT_FAILURE_MESSAGE = "rpc-a unavailable";
const TEST_TOKEN_URI = "ipfs://metadata";
const TEST_HTTP_FAILURE_RESPONSE_BODY = "upstream failed";
const TEST_HTTP_FAILURE_STATUS = 500;
const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const TEST_TOKEN_ID = "1";
const TEST_TOKEN_STANDARD_ERC721 = "erc721";

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
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("retries transient tokenURI failures through the next weighted endpoint", async () => {
        const attemptedUrls: string[] = [];
        const createClient: TokenUriRpcClientFactory = (url) =>
            ({
                readContract: async () => {
                    attemptedUrls.push(url);
                    if (url === TEST_RPC_ENDPOINT_A_URL) {
                        throw new Error(TEST_RPC_ENDPOINT_FAILURE_MESSAGE);
                    }
                    return TEST_TOKEN_URI;
                },
            }) as ReturnType<TokenUriRpcClientFactory>;
        const resolver = new ViemTokenUriResolver({
            endpoints: [
                { url: TEST_RPC_ENDPOINT_A_URL, weight: 1 },
                { url: TEST_RPC_ENDPOINT_B_URL, weight: 1 },
            ],
            retryPolicy: TEST_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            sleep: async () => {},
            createClient,
        });

        await expect(
            resolver.resolveTokenUri(
                TEST_CONTRACT_ADDRESS,
                TEST_TOKEN_ID,
                TEST_TOKEN_STANDARD_ERC721,
            ),
        ).resolves.toBe(TEST_TOKEN_URI);
        expect(attemptedUrls).toEqual([
            TEST_RPC_ENDPOINT_A_URL,
            TEST_RPC_ENDPOINT_B_URL,
        ]);
    });

    it("disables viem internal retries under the metadata RPC retry policy", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(TEST_HTTP_FAILURE_RESPONSE_BODY, {
                    status: TEST_HTTP_FAILURE_STATUS,
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const resolver = new ViemTokenUriResolver({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
        });

        await expect(
            resolver.resolveTokenUri(
                TEST_CONTRACT_ADDRESS,
                TEST_TOKEN_ID,
                TEST_TOKEN_STANDARD_ERC721,
            ),
        ).resolves.toBeNull();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
