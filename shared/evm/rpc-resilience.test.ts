import { describe, expect, it } from "vitest";
import {
    RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES,
    RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT,
} from "./rpc-errors.js";
import {
    CircuitBreaker,
    CircuitOpenError,
    executeWithRpcRetry,
    fetchWithRpcRequestTimeout,
    RpcRequestTimeoutError,
    TokenBucketRateLimiter,
} from "./rpc-resilience.js";

const TEST_IGNORED_CIRCUIT_FAILURE_MESSAGE = "ignored circuit failure";
const TEST_DETERMINISTIC_CONTRACT_OUTER_MESSAGE = "contract read failed";

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

    it("leaves the circuit closed when failure accounting ignores an error", async () => {
        const breaker = new CircuitBreaker(
            {
                failureThreshold: 1,
                openMs: 1_000,
                halfOpenMaxRequests: 1,
            },
            () => 0,
        );

        await expect(
            breaker.execute(
                async () => {
                    throw new Error(TEST_IGNORED_CIRCUIT_FAILURE_MESSAGE);
                },
                { shouldRecordFailure: () => false },
            ),
        ).rejects.toThrow(TEST_IGNORED_CIRCUIT_FAILURE_MESSAGE);
        await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
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

    it("surfaces deterministic contract failures without retry delay", async () => {
        const scheduled: Array<{
            attempt: number;
            nextAttempt: number;
            delayMs: number;
        }> = [];
        const sleeps: number[] = [];
        let attempts = 0;

        await expect(
            executeWithRpcRetry({
                policy: {
                    maxAttempts: 3,
                    baseDelayMs: 100,
                    maxDelayMs: 150,
                },
                executeAttempt: async () => {
                    attempts += 1;
                    throw buildDeterministicContractError();
                },
                onRetryScheduled: ({ attempt, nextAttempt, delayMs }) => {
                    scheduled.push({ attempt, nextAttempt, delayMs });
                },
                sleep: async (ms) => {
                    sleeps.push(ms);
                },
            }),
        ).rejects.toThrow(TEST_DETERMINISTIC_CONTRACT_OUTER_MESSAGE);

        expect(attempts).toBe(1);
        expect(scheduled).toEqual([]);
        expect(sleeps).toEqual([]);
    });
});

describe("fetchWithRpcRequestTimeout", () => {
    it("aborts and rejects when a fetch attempt exceeds its timeout", async () => {
        let requestSignal: AbortSignal | undefined;
        const fetchRpc: typeof fetch = async (_input, init) => {
            requestSignal = init?.signal ?? undefined;
            return new Promise<Response>(() => {});
        };

        await expect(
            fetchWithRpcRequestTimeout(
                fetchRpc,
                "https://rpc-a.example",
                {},
                1,
            ),
        ).rejects.toBeInstanceOf(RpcRequestTimeoutError);
        expect(requestSignal?.aborted).toBe(true);
    });
});

function buildDeterministicContractError(): Error {
    const cause = Object.assign(
        new Error(RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT.ReturnedNoData),
        {
            name: RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES.ContractFunctionZeroData,
        },
    );
    return Object.assign(new Error(TEST_DETERMINISTIC_CONTRACT_OUTER_MESSAGE), {
        cause,
    });
}
