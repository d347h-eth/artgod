import { describe, expect, it, vi } from "vitest";
import {
    fetchWithHttpResilience,
    getHttpFetchRetryDelayMs,
    HttpFetchRequestTimeoutError,
    HttpFetchRetryableStatusError,
    type HttpFetchResilienceConfig,
} from "./http-fetch-resilience.js";

const TEST_HTTP_FETCH_RESILIENCE: HttpFetchResilienceConfig = {
    requestTimeoutMs: 1000,
    retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 25,
        maxDelayMs: 60,
    },
};

describe("fetchWithHttpResilience", () => {
    it("retries failed fetch attempts with bounded exponential backoff", async () => {
        const sleeps: number[] = [];
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new Error("network unavailable"))
            .mockResolvedValueOnce(new Response("retry", { status: 503 }))
            .mockResolvedValueOnce(new Response("ok", { status: 200 }));

        const response = await fetchWithHttpResilience({
            input: "https://metadata.example/token/1",
            config: TEST_HTTP_FETCH_RESILIENCE,
            fetchImpl,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });

        expect(await response.text()).toBe("ok");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleeps).toEqual([25, 50]);
    });

    it("throws the final retryable status after attempts are exhausted", async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("unavailable", { status: 503 }));

        await expect(
            fetchWithHttpResilience({
                input: "https://metadata.example/token/1",
                config: {
                    ...TEST_HTTP_FETCH_RESILIENCE,
                    retryPolicy: {
                        ...TEST_HTTP_FETCH_RESILIENCE.retryPolicy,
                        maxAttempts: 2,
                    },
                },
                fetchImpl,
                sleep: async () => {},
            }),
        ).rejects.toBeInstanceOf(HttpFetchRetryableStatusError);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not retry caller-aborted requests", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
            throw init?.signal?.reason ?? new Error("aborted");
        });

        await expect(
            fetchWithHttpResilience({
                input: "https://metadata.example/token/1",
                init: { signal: controller.signal },
                config: TEST_HTTP_FETCH_RESILIENCE,
                fetchImpl,
                sleep: async () => {
                    throw new Error("sleep should not be called");
                },
            }),
        ).rejects.toThrow();

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports request timeouts as typed errors", async () => {
        const fetchImpl = vi.fn<typeof fetch>(
            async (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new Error("aborted by timeout"));
                    });
                }),
        );

        await expect(
            fetchWithHttpResilience({
                input: "https://metadata.example/token/1",
                config: {
                    requestTimeoutMs: 1,
                    retryPolicy: {
                        maxAttempts: 1,
                        baseDelayMs: 0,
                        maxDelayMs: 0,
                    },
                },
                fetchImpl,
            }),
        ).rejects.toBeInstanceOf(HttpFetchRequestTimeoutError);
    });
});

describe("getHttpFetchRetryDelayMs", () => {
    it("caps exponential retry delay", () => {
        expect(
            getHttpFetchRetryDelayMs(4, {
                maxAttempts: 5,
                baseDelayMs: 100,
                maxDelayMs: 250,
            }),
        ).toBe(250);
    });
});
