import type { TradingJobCommandRecord } from "@artgod/shared/types";

// TradingJobCommandSignalPort publishes best-effort wake-up signals after DB Outbox rows are committed.
export interface TradingJobCommandSignalPort {
    publishBiddingJobCommandsChanged(
        commands: TradingJobCommandRecord[],
    ): void;
}
