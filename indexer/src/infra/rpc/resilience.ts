export type RpcRateLimiterConfig = {
    requestsPerSecond: number;
    burst: number;
};

export type RpcCircuitBreakerConfig = {
    failureThreshold: number;
    openMs: number;
    halfOpenMaxRequests: number;
};

export class CircuitOpenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CircuitOpenError";
    }
}

type ClockFn = () => number;
type SleepFn = (ms: number) => Promise<void>;

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
            throw new CircuitOpenError("RPC circuit is open");
        }
        if (
            this.state === "half-open" &&
            this.halfOpenInFlight >=
                Math.max(1, this.config.halfOpenMaxRequests)
        ) {
            // Limit probe concurrency while testing service recovery.
            throw new CircuitOpenError(
                "RPC circuit is half-open and probe limit is reached",
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

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
