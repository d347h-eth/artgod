import { setImmediate } from "node:timers/promises";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from "vitest";
import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { SqliteChainsReadModel } from "@artgod/shared/read-models/chains";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import {
    createBlockspaceFixture,
    BLOCKSPACE_FIXTURE_SLUG,
} from "../../../testing/blockspace-fixture.js";
import { MemoryQueryCache } from "../../../infra/cache/memory.js";
import { SqlitePublicBlockspaceCoverage } from "../../../infra/sync-backfill/sqlite-public-blockspace-coverage.js";
import {
    CachedGetPublicBlockspace,
    PUBLIC_BLOCKSPACE_CACHE_LIMITS,
} from "./cached-get-public-blockspace.js";
import { PublicBlockspaceUnavailableError } from "./public-blockspace-coverage.js";
import { GetSyncBackfillStateUseCase } from "./get-sync-backfill-state.js";
import {
    getCurrentQueryCacheDebugInfo,
    QUERY_CACHE_DEBUG_STATUSES,
    runWithQueryCacheDebugContext,
} from "../../../utils/query-cache-debug.js";

const REFRESH_MS = 60_000;
const input = {
    chainRef: "ethereum",
    collectionRef: BLOCKSPACE_FIXTURE_SLUG,
    collectionOptions: "selected" as const,
};

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

describe("demand-loaded public blockspace responses", () => {
    let fixture: Awaited<ReturnType<typeof createBlockspaceFixture>>;
    let cache: CachedGetPublicBlockspace;
    let loader: SqlitePublicBlockspaceCoverage;
    let load: MockInstance<SqlitePublicBlockspaceCoverage["load"]>;
    let head: number;
    const rpc = {
        getCurrentBlockNumber: vi.fn(async () => 200_000),
        getBlockTimestamp: vi.fn(
            async (block: number) => block + 1_700_000_000,
        ),
    };
    let stores: MemoryQueryCache[];

    beforeEach(async () => {
        fixture = await createBlockspaceFixture();
        fixture.seedHead(200_000);
        fixture.seedCoverage([17, 100, 1023, 1024, 180_000]);
        loader = new SqlitePublicBlockspaceCoverage(
            fixture.path,
            fixture.repository,
        );
        load = vi.spyOn(loader, "load");
        head = 200_000;
        rpc.getCurrentBlockNumber.mockImplementation(async () => head);
        rpc.getBlockTimestamp.mockImplementation(
            async (block) => block + 1_700_000_000,
        );
        stores = [];
        cache = new CachedGetPublicBlockspace(
            fixture.scope,
            REFRESH_MS,
            new SqliteChainsReadModel(),
            loader,
            rpc,
            () => {
                const store = new MemoryQueryCache({
                    maxEntries: PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxResponses,
                });
                stores.push(store);
                return store;
            },
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
    });

    afterEach(async () => {
        await cache.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        fixture.close();
    });

    it.each([false, true])(
        "times one shared refresh with a monotonic clock despite wall-clock changes (failure: %s)",
        async (fails) => {
            const info = vi.spyOn(logger, "info").mockImplementation(() => {});
            const error = vi
                .spyOn(logger, "error")
                .mockImplementation(() => {});
            let clock = 1_000;
            vi.spyOn(performance, "now").mockImplementation(() => clock);
            const held = gate();
            load.mockImplementationOnce(async (scope, signal) => {
                await held.promise;
                if (fails) throw new Error("coverage read failed");
                return SqlitePublicBlockspaceCoverage.prototype.load.call(
                    loader,
                    scope,
                    signal,
                );
            });

            const responses = Promise.allSettled([
                cache.getState(input),
                cache.getState(input),
            ]);
            await setImmediate();
            expect(load).toHaveBeenCalledTimes(1);
            expect(info).not.toHaveBeenCalled();
            expect(error).not.toHaveBeenCalled();

            clock += 125.5;
            vi.setSystemTime(Date.now() - REFRESH_MS);
            held.release();
            const results = await responses;
            expect(results.map((result) => result.status)).toEqual(
                Array(2).fill(fails ? "rejected" : "fulfilled"),
            );
            const completion = fails ? error : info;
            expect(completion).toHaveBeenCalledExactlyOnceWith(
                expect.any(String),
                expect.objectContaining({ durationMs: 125.5 }),
            );
            expect(fails ? info : error).not.toHaveBeenCalled();
        },
    );

    it("does no startup/idle work, coalesces cold callers, and polls without resetting age", async () => {
        await setImmediate();
        vi.setSystemTime(Date.now() + 5 * REFRESH_MS);
        await setImmediate();
        expect(load).not.toHaveBeenCalled();
        const responses = await Promise.all(
            Array.from({ length: 8 }, () => cache.getState(input)),
        );
        expect(load).toHaveBeenCalledTimes(1);
        expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(1);
        expect(responses.every((response) => response === responses[0])).toBe(
            true,
        );
        for (let tick = 1; tick < 12; tick += 1) {
            vi.setSystemTime(Date.now() + 5000);
            await runWithQueryCacheDebugContext(async () => {
                expect(await cache.getState(input)).toBe(responses[0]);
                expect(getCurrentQueryCacheDebugInfo()).toEqual({
                    status: QUERY_CACHE_DEBUG_STATUSES.Hit,
                    ageMs: tick * 5000,
                    ttlMs: REFRESH_MS,
                });
            });
        }
        expect(load).toHaveBeenCalledTimes(1);
        expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + 10 * REFRESH_MS);
        await setImmediate();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("serves old complete pages during one rebuild and replaces coverage and responses together", async () => {
        const old = await cache.getState(input);
        const pageInput = { ...input, pageStartBlock: 0, bucketSize: 1 };
        const oldPage = await cache.getState(pageInput);
        const held = gate();
        load.mockImplementationOnce(async (scope, signal) => {
            await held.promise;
            return loaderLoad(scope, signal);
        });
        const loaderLoad =
            SqlitePublicBlockspaceCoverage.prototype.load.bind(loader);
        fixture.seedCoverage([18, 19]);
        head = 210_000;
        vi.setSystemTime(Date.now() + REFRESH_MS);
        expect(await cache.getState(input)).toBe(old);
        expect(await cache.getState(pageInput)).toBe(oldPage);
        await Promise.all(
            Array.from({ length: 8 }, () => cache.getState(input)),
        );
        expect(load).toHaveBeenCalledTimes(2);
        held.release();
        await vi.waitFor(() =>
            expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(2),
        );
        const updated = await cache.getState(input);
        expect(updated).not.toBe(old);
        expect(updated.summary.syncedBlockCount).toBe(7);
        expect(updated.summary.headBlock).toBe(210_000);
        expect(
            (await cache.getState(pageInput)).summary
                .selectedRangeSyncedBlockCount,
        ).toBe(oldPage.summary.selectedRangeSyncedBlockCount + 2);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("retries temporary cold and refresh failures at the same cadence while retaining last success", async () => {
        load.mockRejectedValueOnce(new Error("temporary SQLite failure"));
        await expect(cache.getState(input)).rejects.toBeInstanceOf(
            PublicBlockspaceUnavailableError,
        );
        await expect(cache.getState(input)).rejects.toBeInstanceOf(
            PublicBlockspaceUnavailableError,
        );
        expect(load).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        const old = await cache.getState(input);
        load.mockRejectedValueOnce(new Error("temporary refresh failure"));
        vi.setSystemTime(Date.now() + REFRESH_MS);
        expect(await cache.getState(input)).toBe(old);
        await setImmediate();
        expect(await cache.getState(input)).toBe(old);
        expect(load).toHaveBeenCalledTimes(3);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
        await vi.waitFor(() =>
            expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(2),
        );
        expect(await cache.getState(input)).not.toBe(old);
    });

    it("retires cached success when eligibility disappears, then admits a later restored scope", async () => {
        await cache.getState(input);
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=NULL WHERE collection_id=?",
        ).run(fixture.collectionId);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await setImmediate();
        await expect(cache.getState(input)).rejects.toBeInstanceOf(
            ReadModelNotFoundError,
        );
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=100 WHERE collection_id=?",
        ).run(fixture.collectionId);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        expect((await cache.getState(input)).summary.syncedBlockCount).toBe(5);
    });

    it("rejects wrong scope before loading and does not let invalid geometry poison valid scope data", async () => {
        await expect(
            cache.getState({ ...input, chainRef: "missing" }),
        ).rejects.toBeInstanceOf(ReadModelNotFoundError);
        await expect(
            cache.getState({ ...input, collectionRef: "other" }),
        ).rejects.toBeInstanceOf(ReadModelNotFoundError);
        expect(load).not.toHaveBeenCalled();
        await expect(
            cache.getState({ ...input, pageStartBlock: 1, bucketSize: 1 }),
        ).rejects.toBeInstanceOf(ReadModelBadRequestError);
        const valid = await cache.getState(input);
        await expect(
            cache.getState({ ...input, pageStartBlock: NaN, bucketSize: NaN }),
        ).rejects.toBeInstanceOf(ReadModelBadRequestError);
        expect(await cache.getState(input)).toBe(valid);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it.each([50, 200_000, 210_000, 1_100_000])(
        "preserves owning geometry, markers, totals, and timestamps at RPC head %i",
        async (currentHead) => {
            head = currentHead;
            const original = new GetSyncBackfillStateUseCase(
                1,
                new SqliteChainsReadModel(),
                fixture.repository,
                rpc,
            );
            for (const request of [
                input,
                { ...input, pageStartBlock: 0, bucketSize: 1 },
                ...(head >= 1024
                    ? [{ ...input, pageStartBlock: 1024, bucketSize: 1 }]
                    : []),
                ...(head > 1_048_576
                    ? [{ ...input, pageStartBlock: 0, bucketSize: 1024 }]
                    : []),
            ]) {
                expect(await cache.getState(request)).toEqual(
                    await original.getState(request),
                );
            }
            const range = {
                ...input,
                fromBlock: 17,
                toBlock: Math.min(head, 1024),
            };
            expect(await cache.getRangeSummary(range)).toEqual(
                await original.getRangeSummary(range),
            );
        },
    );

    it("bounds retained responses without adding head reads or a new freshness clock", async () => {
        const first = await cache.getRangeSummary({
            ...input,
            fromBlock: 17,
            toBlock: 18,
        });
        for (
            let i = 1;
            i <= PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxResponses;
            i += 1
        )
            await cache.getRangeSummary({
                ...input,
                fromBlock: 17 + i,
                toBlock: 18 + i,
            });
        expect(
            await cache.getRangeSummary({
                ...input,
                fromBlock: 17,
                toBlock: 18,
            }),
        ).not.toBe(first);
        expect(load).toHaveBeenCalledTimes(1);
        expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(1);
    });

    it("bounds cold admission, sharing one coverage build for admitted callers", async () => {
        const held = gate();
        load.mockImplementationOnce(async (scope, signal) => {
            await held.promise;
            return SqlitePublicBlockspaceCoverage.prototype.load.call(
                loader,
                scope,
                signal,
            );
        });
        const admitted = Array.from(
            { length: PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxRequests },
            () => cache.getState(input),
        );
        await expect(cache.getState(input)).rejects.toBeInstanceOf(
            PublicBlockspaceUnavailableError,
        );
        held.release();
        const results = await Promise.all(admitted);
        expect(results.every((r) => r === results[0])).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("shares rejected RPC head fallback until a completed refresh captures a new head", async () => {
        rpc.getCurrentBlockNumber.mockRejectedValueOnce(
            new Error("RPC unavailable"),
        );
        const fallback = await cache.getState(input);
        expect(fallback.summary.headSource).toBe("indexed");
        head = 210_000;
        await cache.getState({ ...input, pageStartBlock: 0, bucketSize: 1 });
        expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await vi.waitFor(() =>
            expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(2),
        );
        const updated = await cache.getState(input);
        expect(updated.summary.headBlock).toBe(210_000);
        expect(updated.summary.headSource).toBe("rpc");
    });

    it("revalidates saved geometry after head shrink and recovers an invalid stale page through its pending refresh", async () => {
        const wide = { ...input, pageStartBlock: 0, bucketSize: 1024 };
        await cache.getState(wide);
        head = 50;
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await vi.waitFor(() =>
            expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(2),
        );
        expect((await cache.getState(input)).summary.headBlock).toBe(50);
        await expect(cache.getState(wide)).rejects.toBeInstanceOf(
            ReadModelBadRequestError,
        );
        head = 210_000;
        vi.setSystemTime(Date.now() + REFRESH_MS);
        const restored = await cache.getState(wide);
        expect(restored.summary.headBlock).toBe(head);
        expect(restored.range.bucketSize).toBe(1024);
        expect(load).toHaveBeenCalledTimes(3);
    });

    it("fences a late old response after a refresh detects scope retirement", async () => {
        await cache.getState(input);
        const held = gate();
        rpc.getBlockTimestamp.mockImplementation(async (block) => {
            await held.promise;
            return block;
        });
        const pending = cache.getRangeSummary({
            ...input,
            fromBlock: 1500,
            toBlock: 1500,
        });
        await setImmediate();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=NULL WHERE collection_id=?",
        ).run(fixture.collectionId);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await setImmediate();
        await expect(cache.getState(input)).rejects.toBeInstanceOf(
            ReadModelNotFoundError,
        );
        held.release();
        await expect(pending).rejects.toBeInstanceOf(ReadModelNotFoundError);
    });

    it("bounds distinct pending response work and cancels callers without waiting for foreign RPC", async () => {
        const root = await cache.getState(input);
        const held = gate();
        rpc.getBlockTimestamp.mockImplementation(async (block) => {
            await held.promise;
            return block;
        });
        const lateWrites = vi.spyOn(stores[0], "set");
        const admitted = Array.from(
            { length: PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxPendingResponses },
            (_, i) =>
                cache.getRangeSummary({
                    ...input,
                    fromBlock: 1000 + i,
                    toBlock: 1000 + i,
                }),
        );
        const settled = Promise.allSettled(admitted);
        await setImmediate();
        await expect(
            cache.getRangeSummary({ ...input, fromBlock: 2000, toBlock: 2000 }),
        ).rejects.toBeInstanceOf(PublicBlockspaceUnavailableError);
        // Saturation cannot keep starting coverage/head work behind slow RPC.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            vi.setSystemTime(Date.now() + REFRESH_MS);
            expect(await cache.getState(input)).toBe(root);
        }
        expect(load).toHaveBeenCalledTimes(1);
        expect(rpc.getCurrentBlockNumber).toHaveBeenCalledTimes(1);
        await cache.stop();
        expect(
            (await settled).every(
                (r) =>
                    r.status === "rejected" &&
                    r.reason instanceof PublicBlockspaceUnavailableError,
            ),
        ).toBe(true);
        await expect(cache.getState(input)).rejects.toBeInstanceOf(
            PublicBlockspaceUnavailableError,
        );
        held.release();
        await setImmediate();
        expect(lateWrites).not.toHaveBeenCalled();
    });
});
