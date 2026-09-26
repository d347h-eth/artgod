import { setTimeout as delay } from "node:timers/promises";

/** A single legacy consumer admits at most 200 envelopes/second without a burst. */
export const LEGACY_ORDER_ADMISSION_POLICY = Object.freeze({ intervalMs: 5 });

export class LegacyOrderAdmission {
    private nextAt = 0;
    constructor(
        private readonly clock = () => performance.now(),
        private readonly wait: (ms: number) => Promise<unknown> = delay,
    ) {}
    async enter(): Promise<void> {
        // A monotonic clock avoids either flooding or a long stall after wall-clock changes.
        while (this.clock() < this.nextAt)
            await this.wait(this.nextAt - this.clock());
        this.nextAt = this.clock() + LEGACY_ORDER_ADMISSION_POLICY.intervalMs;
    }
}
