type ClockFn = () => number;

export type TokenBucketRateLimiterConfig = {
    getMax: number;
    getRefillPerSecond: number;
    postMax: number;
    postRefillPerSecond: number;
};

// Numeric rate-limit priorities keep user-driven commands ahead of background hot refreshes.
export const TOKEN_BUCKET_RATE_LIMIT_PRIORITY = {
    Background: 0,
    UserCommand: 1,
} as const;

export type TokenBucketRateLimitPriority =
    (typeof TOKEN_BUCKET_RATE_LIMIT_PRIORITY)[keyof typeof TOKEN_BUCKET_RATE_LIMIT_PRIORITY];

export type TokenBucketRateLimitOptions = {
    priority?: TokenBucketRateLimitPriority;
};

interface PendingRateLimitRequest {
    getCost: number;
    postCost: number;
    priority: TokenBucketRateLimitPriority;
    sequence: number;
    resolve: () => void;
}

// Separate GET and POST token buckets match the OpenSea adapter traffic split.
export class TokenBucketRateLimiter {
    private readonly getMax: number;
    private readonly postMax: number;
    private readonly getRefillPerMs: number;
    private readonly postRefillPerMs: number;
    private getTokens: number;
    private postTokens: number;
    private lastRefillAt: number;
    private pendingRequests: PendingRateLimitRequest[] = [];
    private nextSequence = 1;
    private drainTimer?: ReturnType<typeof setTimeout>;
    private drainTimerAt?: number;

    constructor(
        config: TokenBucketRateLimiterConfig,
        private readonly nowMs: ClockFn = Date.now,
    ) {
        this.getMax = Math.max(1, config.getMax);
        this.postMax = Math.max(1, config.postMax);
        this.getRefillPerMs = Math.max(0, config.getRefillPerSecond) / 1000;
        this.postRefillPerMs = Math.max(0, config.postRefillPerSecond) / 1000;
        this.getTokens = this.getMax;
        this.postTokens = this.postMax;
        this.lastRefillAt = this.nowMs();
    }

    public async wait(
        getCost: number,
        postCost: number,
        options: TokenBucketRateLimitOptions = {},
    ): Promise<void> {
        if (getCost <= 0 && postCost <= 0) {
            return;
        }

        this.refill();
        if (
            this.pendingRequests.length === 0 &&
            this.canSatisfy(getCost, postCost)
        ) {
            this.consume(getCost, postCost);
            return;
        }

        return await new Promise<void>((resolve) => {
            this.pendingRequests.push({
                getCost,
                postCost,
                priority:
                    options.priority ??
                    TOKEN_BUCKET_RATE_LIMIT_PRIORITY.Background,
                sequence: this.nextSequence,
                resolve,
            });
            this.nextSequence += 1;
            this.scheduleDrain(0);
        });
    }

    private refill(): void {
        const now = this.nowMs();
        const deltaMs = now - this.lastRefillAt;
        if (deltaMs <= 0) {
            return;
        }

        this.getTokens = Math.min(
            this.getMax,
            this.getTokens + deltaMs * this.getRefillPerMs,
        );
        this.postTokens = Math.min(
            this.postMax,
            this.postTokens + deltaMs * this.postRefillPerMs,
        );
        this.lastRefillAt = now;
    }

    private scheduleDrain(delayMs: number): void {
        const runAt = this.nowMs() + Math.max(0, Math.ceil(delayMs));
        if (this.drainTimer && this.drainTimerAt !== undefined) {
            if (this.drainTimerAt <= runAt) {
                return;
            }
            clearTimeout(this.drainTimer);
        }

        this.drainTimerAt = runAt;
        this.drainTimer = setTimeout(() => {
            this.drainTimer = undefined;
            this.drainTimerAt = undefined;
            this.drainQueue();
        }, Math.max(0, Math.ceil(delayMs)));
    }

    private drainQueue(): void {
        this.refill();

        while (this.pendingRequests.length > 0) {
            const nextIndex = this.findNextSatisfiableRequestIndex();
            if (nextIndex < 0) {
                this.scheduleDrain(this.computeNextWaitMs());
                return;
            }

            const [request] = this.pendingRequests.splice(nextIndex, 1);
            this.consume(request.getCost, request.postCost);
            request.resolve();
        }
    }

    private findNextSatisfiableRequestIndex(): number {
        const highestPriority = Math.max(
            ...this.pendingRequests.map((request) => request.priority),
        );
        let selectedIndex = -1;
        let selectedSequence = Number.POSITIVE_INFINITY;

        this.pendingRequests.forEach((request, index) => {
            if (request.priority !== highestPriority) {
                return;
            }
            if (!this.canSatisfy(request.getCost, request.postCost)) {
                return;
            }
            if (request.sequence < selectedSequence) {
                selectedSequence = request.sequence;
                selectedIndex = index;
            }
        });

        return selectedIndex;
    }

    private computeNextWaitMs(): number {
        const highestPriority = Math.max(
            ...this.pendingRequests.map((request) => request.priority),
        );
        const nextRequest = this.pendingRequests
            .filter((request) => request.priority === highestPriority)
            .sort((left, right) => left.sequence - right.sequence)[0];

        return this.computeWaitMs(
            nextRequest.getCost,
            nextRequest.postCost,
        );
    }

    private computeWaitMs(getCost: number, postCost: number): number {
        const neededGet = Math.max(0, getCost - this.getTokens);
        const neededPost = Math.max(0, postCost - this.postTokens);
        const getWaitMs =
            neededGet === 0 || this.getRefillPerMs === 0
                ? 0
                : neededGet / this.getRefillPerMs;
        const postWaitMs =
            neededPost === 0 || this.postRefillPerMs === 0
                ? 0
                : neededPost / this.postRefillPerMs;

        return Math.max(getWaitMs, postWaitMs, 25);
    }

    private canSatisfy(getCost: number, postCost: number): boolean {
        return this.getTokens >= getCost && this.postTokens >= postCost;
    }

    private consume(getCost: number, postCost: number): void {
        this.getTokens -= getCost;
        this.postTokens -= postCost;
    }
}
