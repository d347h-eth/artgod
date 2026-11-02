import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@artgod/shared/database";
import {
    createBlockspaceFixture,
    BLOCKSPACE_FIXTURE_DEPLOYMENT,
} from "../../testing/blockspace-fixture.js";
import {
    SqlitePublicBlockspaceCoverage,
    PUBLIC_BLOCKSPACE_READ_POLICY,
} from "./sqlite-public-blockspace-coverage.js";
import { SqliteSyncBackfillRepository } from "./sqlite-sync-backfill-repository.js";
import {
    PublicBlockspaceScopeNotFoundError,
    PublicBlockspaceUnavailableError,
} from "../../application/use-cases/sync-backfill/public-blockspace-coverage.js";

describe("private coherent public coverage reads", () => {
    let fixture: Awaited<ReturnType<typeof createBlockspaceFixture>>;
    let loader: SqlitePublicBlockspaceCoverage;
    beforeEach(async () => {
        fixture = await createBlockspaceFixture();
        loader = new SqlitePublicBlockspaceCoverage(
            fixture.path,
            fixture.repository,
        );
        fixture.seedHead(200_000);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        fixture.close();
    });

    it.each(["empty", "dense", "sparse", "fragmented"])(
        "matches an independent SQLite oracle for %s coverage",
        async (shape) => {
            const members =
                shape === "empty"
                    ? []
                    : shape === "dense"
                      ? Array.from({ length: 180_000 }, (_, i) => i)
                      : shape === "sparse"
                        ? [
                              0, 16, 17, 31, 32, 1023, 1024, 65_535, 65_536,
                              190_001,
                          ]
                        : Array.from({ length: 95_000 }, (_, i) => i * 2);
            fixture.seedCoverage(members);
            const snapshot = await loader.load(
                fixture.scope,
                new AbortController().signal,
            );
            const oracle = db.raw.prepare<
                [number, number, number],
                { n: number }
            >(
                "SELECT COUNT(*) AS n FROM collection_sync_blocks WHERE collection_id=? AND block_number BETWEEN ? AND ?",
            );
            const ranges = [
                { fromBlock: 0, toBlock: 200_001 },
                { fromBlock: 0, toBlock: 16 },
                { fromBlock: 17, toBlock: 17 },
                { fromBlock: 31, toBlock: 32 },
                { fromBlock: 1023, toBlock: 2048 },
            ];
            for (let i = 0; i < 100; i += 1)
                ranges.push({
                    fromBlock: (i * 3137) % 190_000,
                    toBlock: ((i * 3137) % 190_000) + 1024,
                });
            const expected = ranges.map(
                (range) =>
                    oracle.get(
                        fixture.collectionId,
                        Math.max(
                            BLOCKSPACE_FIXTURE_DEPLOYMENT,
                            range.fromBlock,
                        ),
                        range.toBlock,
                    )!.n,
            );
            expect(
                snapshot
                    .countSyncedBlocksByRange(1, fixture.context, ranges)
                    .map((range) => range.syncedBlockCount),
            ).toEqual(expected);
            expect(snapshot.countSyncedBlocks(1, fixture.context)).toBe(
                expected[0],
            );
            // The raw/private repository deliberately retains predeployment counts.
            expect(
                fixture.repository.countSyncedBlocks(1, fixture.context),
            ).toBe(members.length);
        },
    );

    it("keeps membership and metadata in one view while the writer progresses, then releases WAL", async () => {
        fixture.seedCoverage([17, 20, 180_000]);
        const original =
            SqliteSyncBackfillRepository.prototype.countSyncedBlocksInRange;
        let writes = 0;
        vi.spyOn(
            SqliteSyncBackfillRepository.prototype,
            "countSyncedBlocksInRange",
        ).mockImplementation(function (
            this: SqliteSyncBackfillRepository,
            ...args
        ) {
            const count = original.apply(this, args);
            if (writes++ === 0) {
                db.prepare(
                    "DELETE FROM collection_sync_blocks WHERE collection_id=? AND block_number=180000",
                ).run(fixture.collectionId);
                fixture.seedCoverage([18, 180_001]);
                db.prepare(
                    "UPDATE collections SET deployment_block=18 WHERE collection_id=?",
                ).run(fixture.collectionId);
                fixture.seedHead(210_000);
                const checkpoint = db.raw.pragma("wal_checkpoint(PASSIVE)") as {
                    log: number;
                    checkpointed: number;
                }[];
                expect(checkpoint[0].log).toBeGreaterThan(
                    checkpoint[0].checkpointed,
                );
            }
            return count;
        });
        const first = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(first.countSyncedBlocks(1, fixture.context)).toBe(3);
        expect(
            first.countSyncedBlocksInRange(1, fixture.context, {
                fromBlock: 180_000,
                toBlock: 180_000,
            }),
        ).toBe(1);
        expect(
            first
                .listBlockspaceCollections(1)
                .find((c) => c.collectionId === fixture.collectionId)
                ?.deploymentBlock,
        ).toBe(17);
        expect(first.getHighestSyncedBlock(1)).toBe(200_000);
        const next = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(next.countSyncedBlocks(1, fixture.context)).toBe(3);
        expect(
            next.countSyncedBlocksInRange(1, fixture.context, {
                fromBlock: 180_000,
                toBlock: 180_000,
            }),
        ).toBe(0);
        expect(next.getHighestSyncedBlock(1)).toBe(210_000);
        expect(db.raw.pragma("wal_checkpoint(TRUNCATE)")).toEqual([
            { busy: 0, log: 0, checkpointed: 0 },
        ]);
    });

    it("rebuilds bitmap, empty, intervals, and bitmap at an unchanged indexed maximum", async () => {
        const fragmented = Array.from(
            { length: 90_000 },
            (_, index) => 18 + index * 2,
        );
        fixture.seedCoverage(fragmented);
        const first = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(first.countSyncedBlocks(1, fixture.context)).toBe(
            fragmented.length,
        );
        db.prepare(
            "DELETE FROM collection_sync_blocks WHERE collection_id=?",
        ).run(fixture.collectionId);
        const empty = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(empty.countSyncedBlocks(1, fixture.context)).toBe(0);
        fixture.seedCoverage([17, 18, 19, 100]);
        const intervals = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(intervals.countSyncedBlocks(1, fixture.context)).toBe(4);
        db.prepare(
            "DELETE FROM collection_sync_blocks WHERE collection_id=?",
        ).run(fixture.collectionId);
        fixture.seedCoverage(fragmented);
        const last = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(last.countSyncedBlocks(1, fixture.context)).toBe(
            fragmented.length,
        );
        expect(last.getHighestSyncedBlock(1)).toBe(
            first.getHighestSyncedBlock(1),
        );
        expect(first.countSyncedBlocks(1, fixture.context)).toBe(
            fragmented.length,
        );
        expect(empty.countSyncedBlocks(1, fixture.context)).toBe(0);
    });

    it("loads more than one million fragmented intervals through the actual SQLite adapter", async () => {
        fixture.seedHead(2_300_000);
        db.prepare(
            "WITH RECURSIVE n(block) AS (SELECT 17 UNION ALL SELECT block+2 FROM n WHERE block<2200017) " +
                "INSERT INTO collection_sync_blocks(chain_id, collection_id, block_number) SELECT 1, ?, block FROM n",
        ).run(fixture.collectionId);
        const snapshot = await loader.load(
            fixture.scope,
            new AbortController().signal,
        );
        expect(snapshot.countSyncedBlocks(1, fixture.context)).toBe(1_100_001);
        expect(
            snapshot.countSyncedBlocksInRange(1, fixture.context, {
                fromBlock: 17,
                toBlock: 1040,
            }),
        ).toBe(512);
        expect(db.raw.pragma("wal_checkpoint(TRUNCATE)")).toEqual([
            { busy: 0, log: 0, checkpointed: 0 },
        ]);
    }, 15_000);

    it("closes views on cancellation, missing scope, and read budget failure", async () => {
        const controller = new AbortController();
        const pending = loader.load(fixture.scope, controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow();
        await expect(
            loader.load(
                { ...fixture.scope, collectionRef: "missing" },
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(PublicBlockspaceScopeNotFoundError);
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const original =
            SqliteSyncBackfillRepository.prototype.countSyncedBlocksInRange;
        vi.spyOn(
            SqliteSyncBackfillRepository.prototype,
            "countSyncedBlocksInRange",
        ).mockImplementation(function (
            this: SqliteSyncBackfillRepository,
            ...args
        ) {
            const count = original.apply(this, args);
            now += PUBLIC_BLOCKSPACE_READ_POLICY.readBudgetMs;
            return count;
        });
        await expect(
            loader.load(fixture.scope, new AbortController().signal),
        ).rejects.toBeInstanceOf(PublicBlockspaceUnavailableError);
        vi.restoreAllMocks();
        expect(db.raw.pragma("wal_checkpoint(TRUNCATE)")).toEqual([
            { busy: 0, log: 0, checkpointed: 0 },
        ]);
    });
});
