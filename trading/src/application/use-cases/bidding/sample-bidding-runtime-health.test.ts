import { describe, expect, it, vi } from "vitest";
import { BIDDING_COMMAND_QUEUE_STATUS } from "./bidding-command-queue-health.js";
import { COLLECTION_OFFER_FRESHNESS } from "./collection-offer-snapshot-service.js";
import { BIDDER_OBSERVED_POSITION } from "./bidder.js";
import { TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT } from "@artgod/shared/types";
import {
    BIDDING_HEALTH_COMPONENT,
    SampleBiddingRuntimeHealth,
} from "./sample-bidding-runtime-health.js";

const zeroCounts = <T extends string>(
    values: Record<string, T>,
): Record<T, number> =>
    Object.fromEntries(
        Object.values(values).map((value) => [value, 0]),
    ) as Record<T, number>;

describe("SampleBiddingRuntimeHealth", () => {
    it("samples other owners while a queue read is held, reports failure, and recovers next sample", async () => {
        let rejectRead!: (error: Error) => void;
        const pending = new Promise<never>((_resolve, reject) => {
            rejectRead = reject;
        });
        const queue = {
            counts: zeroCounts(BIDDING_COMMAND_QUEUE_STATUS),
            oldestPendingAtMs: null,
            staleProcessing: 0,
        };
        const commands = {
            readQueueHealth: vi
                .fn()
                .mockImplementationOnce(() => pending)
                .mockResolvedValue(queue),
        };
        const snapshots = {
            readFreshness: vi.fn(() => ({
                counts: zeroCounts(COLLECTION_OFFER_FRESHNESS),
                backoffCollections: 0,
                oldestCompleteAtMs: null,
            })),
        };
        const publication = {
            readPublicationHealth: () => ({
                watchedCollections: 0,
                missingCollections: 0,
                laggingCollections: 0,
                oldestPublishedAtMs: null,
                oldestPublishedSnapshotAtMs: null,
            }),
        };
        const positions = {
            readPositionHealth: () => ({
                positions: zeroCounts(BIDDER_OBSERVED_POSITION),
                constraints: zeroCounts(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT),
            }),
        };
        const observer = {
            onCommandQueueHealth: vi.fn(),
            onSnapshotFreshness: vi.fn(),
            onPublicationHealth: vi.fn(),
            onPositionHealth: vi.fn(),
            onHealthSample: vi.fn(),
        };
        const sampler = new SampleBiddingRuntimeHealth(
            commands,
            snapshots,
            publication,
            positions,
            observer,
            12_345,
        );
        const first = sampler.sample();
        await Promise.resolve();
        expect(observer.onSnapshotFreshness).toHaveBeenCalledOnce();
        expect(observer.onPublicationHealth).toHaveBeenCalledOnce();
        expect(observer.onPositionHealth).toHaveBeenCalledOnce();
        expect(observer.onCommandQueueHealth).not.toHaveBeenCalled();
        rejectRead(new Error("synthetic queue read failure"));
        await first;
        expect(observer.onHealthSample).toHaveBeenCalledWith(
            expect.objectContaining({
                component: BIDDING_HEALTH_COMPONENT.CommandQueue,
                succeeded: false,
            }),
        );

        await sampler.sample();
        expect(commands.readQueueHealth).toHaveBeenLastCalledWith(12_345);
        expect(observer.onCommandQueueHealth).toHaveBeenCalledWith(queue);
        expect(observer.onHealthSample).toHaveBeenCalledWith(
            expect.objectContaining({
                component: BIDDING_HEALTH_COMPONENT.CommandQueue,
                succeeded: true,
            }),
        );
        // Monitoring failures must neither break the loop nor suppress independent owner reads.
        observer.onPositionHealth.mockImplementation(() => {
            throw new Error("synthetic observer failure");
        });
        observer.onHealthSample.mockImplementation(() => {
            throw new Error("synthetic observer failure");
        });
        await expect(sampler.sample()).resolves.toBeUndefined();
        expect(snapshots.readFreshness).toHaveBeenCalledTimes(3);
    });
});
