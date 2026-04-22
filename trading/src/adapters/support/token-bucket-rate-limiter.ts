type ClockFn = () => number;
type SleepFn = (ms: number) => Promise<void>;

export type TokenBucketRateLimiterConfig = {
    getMax: number;
    getRefillPerSecond: number;
    postMax: number;
    postRefillPerSecond: number;
};

// Separate GET and POST token buckets match the OpenSea adapter traffic split.
export class TokenBucketRateLimiter {
    private readonly getMax: number;
    private readonly postMax: number;
    private readonly getRefillPerMs: number;
    private readonly postRefillPerMs: number;
    private getTokens: number;
    private postTokens: number;
    private lastRefillAt: number;

    constructor(
        config: TokenBucketRateLimiterConfig,
        private readonly nowMs: ClockFn = Date.now,
        private readonly sleepFn: SleepFn = sleepMs,
    ) {
        this.getMax = Math.max(1, config.getMax);
        this.postMax = Math.max(1, config.postMax);
        this.getRefillPerMs = Math.max(0, config.getRefillPerSecond) / 1000;
        this.postRefillPerMs = Math.max(0, config.postRefillPerSecond) / 1000;
        this.getTokens = this.getMax;
        this.postTokens = this.postMax;
        this.lastRefillAt = this.nowMs();
    }

    public async wait(getCost: number, postCost: number): Promise<void> {
        if (getCost <= 0 && postCost <= 0) {
            return;
        }

        while (true) {
            this.refill();
            if (this.getTokens >= getCost && this.postTokens >= postCost) {
                this.getTokens -= getCost;
                this.postTokens -= postCost;
                return;
            }

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
            const waitMs = Math.max(getWaitMs, postWaitMs, 25);

            await this.sleepFn(Math.ceil(waitMs));
        }
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
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
