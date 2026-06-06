// Policy values that configure JSON-RPC retry attempts.
export type RpcRetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
};

// Policy values that configure a per-endpoint JSON-RPC token bucket.
export type RpcRateLimiterConfig = {
    requestsPerSecond: number;
    burst: number;
};

// Policy values that configure a per-endpoint JSON-RPC circuit breaker.
export type RpcCircuitBreakerConfig = {
    failureThreshold: number;
    openMs: number;
    halfOpenMaxRequests: number;
};

// Groups the per-endpoint resilience controls used by JSON-RPC adapters.
export type RpcEndpointResilienceConfig = {
    rateLimiter: RpcRateLimiterConfig;
    circuitBreaker: RpcCircuitBreakerConfig;
};

// Describes one scheduled retry after a failed JSON-RPC attempt.
export type RpcRetryScheduledContext = {
    attempt: number;
    nextAttempt: number;
    delayMs: number;
    error: unknown;
};

// Inputs for running JSON-RPC work through a bounded retry loop.
export type ExecuteWithRpcRetryOptions<T> = {
    policy: RpcRetryPolicy;
    executeAttempt: (attempt: number) => Promise<T>;
    onRetryScheduled?: (context: RpcRetryScheduledContext) => void;
    sleep?: SleepFn;
};

const RPC_CIRCUIT_OPEN_ERROR_MESSAGE = "RPC circuit is open";
const RPC_CIRCUIT_HALF_OPEN_LIMIT_ERROR_MESSAGE =
    "RPC circuit is half-open and probe limit is reached";

type ClockFn = () => number;
type SleepFn = (ms: number) => Promise<void>;

// Error raised when a JSON-RPC endpoint circuit rejects traffic.
export class CircuitOpenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CircuitOpenError";
    }
}

// TokenBucketRateLimiter smooths JSON-RPC request throughput per endpoint.
export class TokenBucketRateLimiter {
    private readonly requestsPerSecond: number;
    private readonly burst: number;
    private tokens: number;
    private lastRefillMs: number;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        config: RpcRateLimiterConfig,
        private nowMs: ClockFn = Date.now,
        private sleep: SleepFn = sleepMs,
    ) {
        // Defensive clamps keep behavior predictable even with bad config.
        this.requestsPerSecond = Math.max(0, config.requestsPerSecond);
        this.burst = Math.max(1, config.burst);
        this.tokens = this.burst;
        this.lastRefillMs = this.nowMs();
    }

    async acquire(): Promise<number> {
        // Serialize acquires so concurrent callers cannot over-consume tokens.
        // Each caller waits for previous caller to finish refill/consume logic.
        const task = this.queue.then(
            () => this.acquireInternal(),
            () => this.acquireInternal(),
        );
        this.queue = task.then(
            () => undefined,
            () => undefined,
        );
        return task;
    }

    private async acquireInternal(): Promise<number> {
        // Zero or negative RPS means "disabled limiter".
        if (this.requestsPerSecond <= 0) {
            return 0;
        }

        let waitedMs = 0;
        for (;;) {
            this.refillTokens();
            if (this.tokens >= 1) {
                // Consume one token and proceed immediately.
                this.tokens -= 1;
                return waitedMs;
            }

            // Not enough tokens: sleep until enough budget is refilled.
            const deficit = 1 - this.tokens;
            const waitMs = Math.max(
                1,
                Math.ceil((deficit / this.requestsPerSecond) * 1000),
            );
            waitedMs += waitMs;
            await this.sleep(waitMs);
        }
    }

    private refillTokens(): void {
        // Continuous refill model (fractional tokens) capped by burst.
        const now = this.nowMs();
        const elapsedMs = Math.max(0, now - this.lastRefillMs);
        if (elapsedMs <= 0) return;

        const refill = (elapsedMs / 1000) * this.requestsPerSecond;
        this.tokens = Math.min(this.burst, this.tokens + refill);
        this.lastRefillMs = now;
    }
}

type CircuitState = "closed" | "open" | "half-open";

// CircuitBreaker stops repeated JSON-RPC failures from hammering one endpoint.
export class CircuitBreaker {
    private state: CircuitState = "closed";
    private consecutiveFailures = 0;
    private openedAtMs = 0;
    private halfOpenInFlight = 0;
    private halfOpenSuccesses = 0;

    constructor(
        private readonly config: RpcCircuitBreakerConfig,
        private nowMs: ClockFn = Date.now,
    ) {}

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        // Closed -> Open after repeated failures.
        // Open -> Half-open after cooldown.
        // Half-open -> Closed after enough successful probes.
        this.transitionOpenToHalfOpenIfReady();
        this.ensureRequestAllowed();

        if (this.state === "half-open") {
            return this.executeHalfOpen(fn);
        }

        try {
            const result = await fn();
            this.consecutiveFailures = 0;
            return result;
        } catch (error) {
            this.consecutiveFailures += 1;
            if (
                this.consecutiveFailures >=
                Math.max(1, this.config.failureThreshold)
            ) {
                this.openCircuit();
            }
            throw error;
        }
    }

    private transitionOpenToHalfOpenIfReady(): void {
        if (this.state !== "open") return;
        // Cooldown gate before allowing probe traffic.
        const openMs = Math.max(1, this.config.openMs);
        if (this.nowMs() - this.openedAtMs < openMs) return;

        this.state = "half-open";
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
    }

    private ensureRequestAllowed(): void {
        if (this.state === "open") {
            throw new CircuitOpenError(RPC_CIRCUIT_OPEN_ERROR_MESSAGE);
        }
        if (
            this.state === "half-open" &&
            this.halfOpenInFlight >=
                Math.max(1, this.config.halfOpenMaxRequests)
        ) {
            // Limit probe concurrency while testing service recovery.
            throw new CircuitOpenError(
                RPC_CIRCUIT_HALF_OPEN_LIMIT_ERROR_MESSAGE,
            );
        }
    }

    private async executeHalfOpen<T>(fn: () => Promise<T>): Promise<T> {
        // Any probe failure re-opens the circuit immediately.
        // Successful probes close the circuit once threshold is met.
        this.halfOpenInFlight += 1;
        let succeeded = false;
        try {
            const result = await fn();
            succeeded = true;
            return result;
        } catch (error) {
            this.openCircuit();
            throw error;
        } finally {
            this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
            if (succeeded) {
                this.halfOpenSuccesses += 1;
                if (
                    this.halfOpenSuccesses >=
                        Math.max(1, this.config.halfOpenMaxRequests) &&
                    this.halfOpenInFlight === 0
                ) {
                    this.closeCircuit();
                }
            }
        }
    }

    private openCircuit(): void {
        this.state = "open";
        this.openedAtMs = this.nowMs();
        this.consecutiveFailures = 0;
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
    }

    private closeCircuit(): void {
        this.state = "closed";
        this.consecutiveFailures = 0;
        this.halfOpenInFlight = 0;
        this.halfOpenSuccesses = 0;
    }
}

// Runs JSON-RPC work through bounded retry with exponential backoff.
export async function executeWithRpcRetry<T>(
    options: ExecuteWithRpcRetryOptions<T>,
): Promise<T> {
    const sleep = options.sleep ?? sleepMs;
    let attempt = 1;
    for (;;) {
        try {
            return await options.executeAttempt(attempt);
        } catch (error) {
            if (attempt >= options.policy.maxAttempts) {
                throw error;
            }
            const delayMs = getRpcRetryDelayMs(attempt, options.policy);
            options.onRetryScheduled?.({
                attempt,
                nextAttempt: attempt + 1,
                delayMs,
                error,
            });
            await sleep(delayMs);
            attempt += 1;
        }
    }
}

// Computes the bounded exponential backoff delay for one retry attempt.
export function getRpcRetryDelayMs(
    attempt: number,
    policy: RpcRetryPolicy,
): number {
    const exp = Math.max(0, attempt - 1);
    const delay = policy.baseDelayMs * Math.pow(2, exp);
    return Math.min(delay, policy.maxDelayMs);
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
