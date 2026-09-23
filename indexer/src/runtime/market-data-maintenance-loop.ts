import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";

/** Online maintenance only. Startup recovery and WAL diagnostics have separate schedules. */
export function startMarketDataMaintenanceLoop(
    tasks: {
        removeObsoleteOrders(nowSeconds: number): number;
        refreshListingPrices(nowSeconds: number): number;
        onPass(durationMs: number): void;
        onError(error: unknown): void;
    },
    options: {
        monotonicNow?: () => number;
        yield?: () => Promise<void>;
    } = {},
): () => void {
    const clock = options.monotonicNow ?? (() => performance.now());
    const yieldBetweenBatches =
        options.yield ??
        (() => new Promise<void>((resolve) => setImmediate(resolve)));
    const batches = [tasks.removeObsoleteOrders, tasks.refreshListingPrices];
    let nextBatch = 0;
    let pricesDone = false;
    let pricesDueAt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    function schedule(delay: number): void {
        timer = setTimeout(run, delay);
        timer.unref();
    }

    async function run(): Promise<void> {
        if (stopped) return;
        const started = clock();
        let delay = POLICY.maintenanceIntervalMs;
        if (pricesDone && Date.now() >= pricesDueAt) pricesDone = false;
        // Recheck orders on continuations: more can become obsolete during a
        // long price pass. Completed prices wait for their normal cadence, even
        // if order cleanup needs many continuations.
        const done = [false, pricesDone];
        try {
            const now = Math.floor(Date.now() / 1000);
            while (
                !stopped &&
                clock() - started < POLICY.maintenancePassBudgetMs
            ) {
                const index = nextBatch;
                nextBatch = (nextBatch + 1) % batches.length;
                if (done[index]) continue;
                done[index] = batches[index]!(now) === 0;
                if (done.every(Boolean)) break;
                // Alternate work across budget boundaries so neither family is starved.
                await yieldBetweenBatches();
            }
            if (stopped) return;
            if (done[1] && !pricesDone)
                pricesDueAt = Date.now() + POLICY.maintenanceIntervalMs;
            pricesDone = done[1]!;
            if (done.every(Boolean)) pricesDone = false;
            else delay = POLICY.maintenanceContinuationDelayMs;
            tasks.onPass(clock() - started);
        } catch (error) {
            pricesDone = false;
            // Failures use the normal cadence, not a rapid retry loop.
            delay = POLICY.maintenanceIntervalMs;
            tasks.onError(error);
        } finally {
            // Scheduling only after completion prevents overlapping passes.
            if (!stopped) schedule(delay);
        }
    }

    schedule(POLICY.maintenanceIntervalMs);
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
