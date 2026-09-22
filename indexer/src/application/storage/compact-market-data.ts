import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";

export const MARKET_DATA_COMPACTION_SKIP_REASON = {
    AlreadyAttempted: "already-attempted",
    CheckpointBusy: "checkpoint-busy",
    LittleReclaimableSpace: "little-reclaimable-space",
    InsufficientHeadroom: "insufficient-compaction-headroom",
} as const;
export type MarketDataCompactionSkipReason =
    (typeof MARKET_DATA_COMPACTION_SKIP_REASON)[keyof typeof MARKET_DATA_COMPACTION_SKIP_REASON];

export type MarketDataCompactionResult = {
    beforeBytes: number;
    afterBytes: number;
    reclaimedBytes: number;
} & (
    | { compacted: true }
    | { compacted: false; reason: MarketDataCompactionSkipReason }
);

export interface MarketDataCompactionPort {
    inspectCompaction(): { recoveryComplete: boolean; attempted: boolean };
    /** Flush committed data before measuring/reclaiming its file allocation. */
    prepareCompaction(): boolean;
    compactionSpace(): {
        fileBytes: number;
        liveBytes: number;
        reclaimableBytes: number;
        availableBytes: number;
    };
    /** Persist before the expensive operation, so an interrupted attempt is not repeated automatically. */
    recordCompactionAttempt(): void;
    /** Reclaim storage, verify durability, record completion and return the resulting file size. */
    compact(): number;
}

/** Optional startup shrinking is separate from logical recovery readiness. */
export class CompactMarketData {
    constructor(private readonly storage: MarketDataCompactionPort) {}

    execute(): MarketDataCompactionResult {
        const state = this.storage.inspectCompaction();
        if (!state.recoveryComplete)
            throw new Error("Logical recovery must complete before compaction");
        const skip = (
            reason: MarketDataCompactionSkipReason,
            fileBytes: number,
        ): MarketDataCompactionResult => ({
            compacted: false,
            reason,
            beforeBytes: fileBytes,
            afterBytes: fileBytes,
            reclaimedBytes: 0,
        });
        if (state.attempted)
            return skip(
                MARKET_DATA_COMPACTION_SKIP_REASON.AlreadyAttempted,
                this.storage.compactionSpace().fileBytes,
            );
        if (!this.storage.prepareCompaction())
            return skip(
                MARKET_DATA_COMPACTION_SKIP_REASON.CheckpointBusy,
                this.storage.compactionSpace().fileBytes,
            );
        const space = this.storage.compactionSpace();
        if (space.reclaimableBytes < POLICY.compactionMinReclaimBytes)
            return skip(
                MARKET_DATA_COMPACTION_SKIP_REASON.LittleReclaimableSpace,
                space.fileBytes,
            );
        // Live image plus WAL/temporary space; this is a preflight, not a reservation.
        if (
            space.availableBytes <
            3 * space.liveBytes + POLICY.recoveryMinFreeBytes
        )
            return skip(
                MARKET_DATA_COMPACTION_SKIP_REASON.InsufficientHeadroom,
                space.fileBytes,
            );
        this.storage.recordCompactionAttempt();
        const afterBytes = this.storage.compact();
        return {
            compacted: true,
            beforeBytes: space.fileBytes,
            afterBytes,
            reclaimedBytes: Math.max(0, space.fileBytes - afterBytes),
        };
    }
}
