import { strict as assert } from "node:assert";
import { afterEach, describe, it, vi } from "vitest";
import { startBiddingFailedCancellationReconciliationLoop } from "./bidding-failed-cancellation-reconciliation-loop.js";
import { shutdownBiddingRuntime } from "./bidding-runtime.js";

describe("failed-cancellation reconciliation loop", () => {
    afterEach(() => vi.useRealTimers());

    it("closes admission immediately while runtime shutdown waits for bidder work", async () => {
        vi.useFakeTimers();
        const reconcileFailedCancellations = vi.fn(async () => 0);
        const closeAdmission = vi.fn();
        const loop = startBiddingFailedCancellationReconciliationLoop(
            { reconcileFailedCancellations, closeAdmission },
            100,
        );
        let releaseBidder!: () => void;
        const bidderGate = new Promise<void>((resolve) => {
            releaseBidder = resolve;
        });
        const bidderDrain = vi.fn(() => bidderGate);
        const shutdown = shutdownBiddingRuntime({
            closeBidderBackgroundAdmission: () => undefined,
            closeCommandAdmission: () => undefined,
            closeFailedCancellationAdmission: () => loop.closeAdmission(),
            commandAdmissionDrains: [],
            bidPipelineDrain: () => undefined,
            bidderDrain,
            collectionSnapshotDrain: () => undefined,
            bidBookProjectionDrain: () => undefined,
            independentDrains: [() => loop.shutdown()],
            bidStreams: new Map(),
            disconnectStreamClient: () => undefined,
            stopHeartbeat: () => undefined,
            markStopped: () => undefined,
            setMetricState: () => undefined,
            now: Date.now,
        });

        assert.equal(closeAdmission.mock.calls.length, 1);
        await vi.advanceTimersByTimeAsync(500);
        assert.equal(bidderDrain.mock.calls.length, 1);
        assert.equal(reconcileFailedCancellations.mock.calls.length, 0);

        releaseBidder();
        await shutdown;
        assert.equal(vi.getTimerCount(), 0);
    });

    it("waits for an admitted batch without scheduling another poll", async () => {
        vi.useFakeTimers();
        let releaseBatch!: (count: number) => void;
        const batch = new Promise<number>((resolve) => {
            releaseBatch = resolve;
        });
        const reconcileFailedCancellations = vi.fn(() => batch);
        const closeAdmission = vi.fn();
        const loop = startBiddingFailedCancellationReconciliationLoop(
            { reconcileFailedCancellations, closeAdmission },
            100,
        );
        await vi.advanceTimersByTimeAsync(100);
        assert.equal(reconcileFailedCancellations.mock.calls.length, 1);

        let settled = false;
        const shutdown = loop.shutdown().then(() => {
            settled = true;
        });
        assert.equal(closeAdmission.mock.calls.length, 1);
        await vi.advanceTimersByTimeAsync(500);
        assert.equal(settled, false);
        assert.equal(reconcileFailedCancellations.mock.calls.length, 1);

        releaseBatch(0);
        await shutdown;
        await vi.advanceTimersByTimeAsync(500);
        assert.equal(settled, true);
        assert.equal(reconcileFailedCancellations.mock.calls.length, 1);
        assert.equal(vi.getTimerCount(), 0);
    });
});
