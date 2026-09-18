export interface BiddingHealthSampler {
    sample(): Promise<void>;
}

// A single heartbeat-paced read at a time; neither scrape requests nor held commands drive sampling.
export function startBiddingHealthSamplingLoop(
    sampler: BiddingHealthSampler,
    intervalMs: number,
): { shutdown(): Promise<void> } {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
        throw new Error("Health sampling interval must be a positive integer");
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void>;
    const run = () => {
        inFlight = sampler
            .sample()
            .catch(() => undefined)
            .finally(() => {
                if (!stopped) {
                    timer = setTimeout(run, intervalMs);
                    timer.unref();
                }
            });
    };
    run();
    return {
        async shutdown() {
            stopped = true;
            if (timer) clearTimeout(timer);
            await inFlight;
        },
    };
}
