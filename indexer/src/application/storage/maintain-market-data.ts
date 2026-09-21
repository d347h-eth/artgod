import {
    MARKET_DATA_STORAGE_POLICY as POLICY,
    MARKET_DATA_RECOVERY_STAGE as STAGE,
    type MarketDataRecoveryStage,
} from "@artgod/shared/market-data/storage-policy";

export type MarketDataRecoveryProgress = {
    stage: MarketDataRecoveryStage;
    cursor: number;
    removedRows: number;
};

export type MarketDataCompactionResult = {
    compacted: boolean;
    reason?: string;
    beforeBytes: number;
    afterBytes: number;
    reclaimedBytes: number;
};

/** Each batch commits its data and resume position atomically. No network work is done under the writer lock. */
export interface MarketDataMaintenancePort {
    inspect(): MarketDataRecoveryProgress;
    recoverBatch(nowSeconds: number): MarketDataRecoveryProgress;
    maintainBatch(nowSeconds: number): number;
    checkpoint(): { busy: number; log: number; checkpointed: number };
    compactIfSafe(): MarketDataCompactionResult;
}

export class MaintainMarketData {
    constructor(
        private readonly storage: MarketDataMaintenancePort,
        private readonly options: {
            monotonicNow?: () => number;
            nowSeconds?: () => number;
            yield?: () => Promise<void>;
            report?: (progress: MarketDataRecoveryProgress) => void;
        } = {},
    ) {}

    async recover(signal?: AbortSignal): Promise<MarketDataRecoveryProgress> {
        const clock = this.options.monotonicNow ?? (() => performance.now());
        const end = clock() + POLICY.recoveryBudgetMs;
        let progress = this.storage.inspect();
        let lastReport = -Infinity;
        do {
            signal?.throwIfAborted();
            if (clock() >= end)
                throw new Error(
                    "SQLite market-data recovery exceeded its work deadline; retry to resume committed progress.",
                );
            const now =
                this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
            // Completed recovery is not a request for an online orderbook scan.
            if (progress.stage === STAGE.Complete) break;
            progress = this.storage.recoverBatch(now);
            if (
                clock() - lastReport >= 1_000 ||
                progress.stage === STAGE.Complete
            ) {
                this.options.report?.(progress);
                lastReport = clock();
            }
            await (this.options.yield?.() ??
                new Promise<void>((resolve) => setImmediate(resolve)));
        } while (true);
        const checkpoint = this.storage.checkpoint();
        if (checkpoint.busy || checkpoint.log !== checkpoint.checkpointed) {
            throw new Error(
                "SQLite recovery checkpoint is blocked by another database client. Stop that client and retry.",
            );
        }
        return progress;
    }
}
