import { describe, expect, it, vi } from "vitest";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    CompactMarketData,
    MARKET_DATA_COMPACTION_SKIP_REASON as REASON,
} from "../src/application/storage/compact-market-data.js";

function fixture() {
    return {
        inspectCompaction: vi.fn(() => ({
            recoveryComplete: true,
            attempted: false,
        })),
        prepareCompaction: vi.fn(() => true),
        compactionSpace: vi.fn(() => ({
            fileBytes: POLICY.compactionMinReclaimBytes * 2,
            reclaimableBytes: POLICY.compactionMinReclaimBytes,
            liveBytes: POLICY.compactionMinReclaimBytes,
            availableBytes:
                4 * POLICY.compactionMinReclaimBytes +
                POLICY.recoveryMinFreeBytes,
        })),
        recordCompactionAttempt: vi.fn(),
        compact: vi.fn(() => POLICY.compactionMinReclaimBytes),
    };
}

describe("optional market-data compaction", () => {
    it("refuses to shrink before logical recovery is ready", () => {
        const port = fixture();
        port.inspectCompaction.mockReturnValue({
            recoveryComplete: false,
            attempted: false,
        });
        expect(() => new CompactMarketData(port).execute()).toThrow(
            "Logical recovery",
        );
        expect(port.prepareCompaction).not.toHaveBeenCalled();
        expect(port.compact).not.toHaveBeenCalled();
    });

    it.each([
        REASON.AlreadyAttempted,
        REASON.CheckpointBusy,
        REASON.LittleReclaimableSpace,
        REASON.InsufficientHeadroom,
    ])("skips %s without recording an expensive attempt", (reason) => {
        const port = fixture();
        if (reason === REASON.AlreadyAttempted)
            port.inspectCompaction.mockReturnValue({
                recoveryComplete: true,
                attempted: true,
            });
        if (reason === REASON.CheckpointBusy)
            port.prepareCompaction.mockReturnValue(false);
        const space = port.compactionSpace();
        if (reason === REASON.LittleReclaimableSpace)
            space.reclaimableBytes = POLICY.compactionMinReclaimBytes - 1;
        if (reason === REASON.InsufficientHeadroom)
            space.availableBytes =
                3 * space.liveBytes + POLICY.recoveryMinFreeBytes - 1;
        port.compactionSpace.mockReturnValue(space);
        expect(new CompactMarketData(port).execute()).toMatchObject({
            compacted: false,
            reason,
            reclaimedBytes: 0,
        });
        expect(port.recordCompactionAttempt).not.toHaveBeenCalled();
        expect(port.compact).not.toHaveBeenCalled();
    });

    it("allows the exact headroom boundary and records the attempt before shrinking", () => {
        const port = fixture();
        const space = port.compactionSpace();
        space.availableBytes =
            3 * space.liveBytes + POLICY.recoveryMinFreeBytes;
        port.compactionSpace.mockReturnValue(space);
        port.compact.mockImplementation(() => {
            expect(port.recordCompactionAttempt).toHaveBeenCalledTimes(1);
            return space.liveBytes;
        });
        expect(new CompactMarketData(port).execute()).toEqual({
            compacted: true,
            beforeBytes: space.fileBytes,
            afterBytes: space.liveBytes,
            reclaimedBytes: space.reclaimableBytes,
        });
    });

    it("leaves an attempted marker when the physical operation fails", () => {
        const port = fixture();
        port.compact.mockImplementation(() => {
            throw new Error("fixture failure");
        });
        expect(() => new CompactMarketData(port).execute()).toThrow(
            "fixture failure",
        );
        expect(port.recordCompactionAttempt).toHaveBeenCalledTimes(1);
    });
});
