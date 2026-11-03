import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@artgod/shared/database";
import { SqliteChainsReadModel } from "@artgod/shared/read-models/chains";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import {
    createBlockspaceFixture,
    BLOCKSPACE_FIXTURE_SLUG,
} from "../../backend/src/testing/blockspace-fixture.js";
import {
    CachedGetPublicBlockspace,
    PUBLIC_BLOCKSPACE_CACHE_LIMITS,
} from "../../backend/src/application/use-cases/sync-backfill/cached-get-public-blockspace.js";
import { MemoryQueryCache } from "../../backend/src/infra/cache/memory.js";
import { SqlitePublicBlockspaceCoverage } from "../../backend/src/infra/sync-backfill/sqlite-public-blockspace-coverage.js";
import { SqliteCollectionPurgeRepository } from "../../backend/src/infra/collections/sqlite-collection-purge-repository.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { SqliteSyncRangeCommit } from "../src/infra/storage/sqlite-sync-range-commit.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteReorgRecoveries } from "../src/infra/storage/sqlite-reorg-recoveries.js";
import { SqliteCanonicalChecks } from "../src/infra/storage/sqlite-canonical-checks.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { SYNC_WORK_COMPLETION } from "../src/domain/sync-work.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    SYNC_JOB_KIND,
} from "../src/domain/sync-jobs.js";
import { buildSyncFollowUps } from "../src/application/sync-range-processing.js";
import type { SyncRangeCommit } from "../src/ports/sync-range-commit.js";
import {
    emptyOnChainData,
    loadCollection,
} from "./helpers/ownership-fixture.js";
import {
    FINALIZED_SYNC_CHECK_POLICY,
    syncBlockFixture,
} from "./helpers/chain-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";

const REFRESH_MS = 60_000;
const input = {
    chainRef: "ethereum",
    collectionRef: BLOCKSPACE_FIXTURE_SLUG,
    collectionOptions: "selected" as const,
};

describe("public cache observes canonical owner mutations", () => {
    let f: Awaited<ReturnType<typeof createBlockspaceFixture>>;
    let cache: CachedGetPublicBlockspace;
    let storage: SqliteStorage;
    let gaps: SqliteSyncGapStore;
    let commit: SqliteSyncRangeCommit;
    let serial: number;

    function write(
        numbers: number[],
        collectionId = f.collectionId,
        completion: SyncRangeCommit["completion"] = {
            kind: SYNC_WORK_COMPLETION.Unmanaged,
        },
        checkpoint = storage.captureSyncCheckpoint(1),
    ) {
        const result = {
            checkpoint,
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            blocks: numbers.map(syncBlockFixture),
            data: emptyOnChainData(),
            collections: [loadCollection(1, collectionId)],
        };
        const sourceJobId = `public-cache-fixture-${serial++}`;
        const followUps = buildSyncFollowUps(
            1,
            result.collections,
            { fromBlock: numbers[0], toBlock: numbers[numbers.length - 1] },
            [
                {
                    fanoutId: sourceJobId,
                    sourceJobId,
                    sourceKind: SYNC_JOB_KIND.BackfillRange,
                },
            ],
            "backfill",
            result.data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
        );
        commit.commitSyncRange({ result, followUps, completion });
    }

    async function refresh() {
        const old = await cache.getState(input);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await vi.waitFor(async () =>
            expect(await cache.getState(input)).not.toBe(old),
        );
        return cache.getState(input);
    }

    beforeEach(async () => {
        f = await createBlockspaceFixture();
        storage = new SqliteStorage();
        gaps = new SqliteSyncGapStore();
        commit = new SqliteSyncRangeCommit({
            storage,
            gaps,
            collections: new SqliteCollectionRegistry(),
            outbox: new SqliteQueueOutbox(),
            recoveries: new SqliteReorgRecoveries(
                storage,
                new SqliteCanonicalChecks(),
            ),
        });
        cache = new CachedGetPublicBlockspace(
            f.scope,
            REFRESH_MS,
            new SqliteChainsReadModel(),
            new SqlitePublicBlockspaceCoverage(f.path, f.repository),
            {
                getCurrentBlockNumber: async () => 200_000,
                getBlockTimestamp: async (block) => block,
            },
            () =>
                new MemoryQueryCache({
                    maxEntries: PUBLIC_BLOCKSPACE_CACHE_LIMITS.maxResponses,
                }),
        );
        serial = 0;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
    });

    afterEach(async () => {
        await cache.stop();
        vi.useRealTimers();
        f.close();
    });

    it("counts empty-event acquisition and duplicates, old gap fill, and same-count historical movement", async () => {
        for (const block of [17, 100, 500, 10_000]) write([block]);
        write([500]);
        expect((await cache.getState(input)).summary.syncedBlockCount).toBe(4);
        const before = storage.captureSyncCheckpoint(1);
        const max = f.repository.getHighestSyncedBlock(1);
        const repair = {
            collectionId: f.collectionId,
            repairId: "public-cache-gap",
            anchorBlock: 100,
            fromBlock: 600,
            toBlock: 602,
        };
        expect(
            gaps.saveProgress({
                chainId: 1,
                collectionId: f.collectionId,
                expected: null,
                progress: {
                    anchorBlock: 100,
                    cursorBlock: 602,
                    pending: {
                        repairId: repair.repairId,
                        fromBlock: 600,
                        toBlock: 602,
                        retryAt: 0,
                    },
                    lastHeadCheckAt: null,
                },
            }),
        ).toBe(true);
        write([600, 601, 602], f.collectionId, {
            kind: SYNC_WORK_COMPLETION.GapRepair,
            batch: { fromBlock: 600, toBlock: 602, repairs: [repair] },
            retryAt: 0,
        });
        expect(storage.captureSyncCheckpoint(1)).toEqual(before);
        expect(f.repository.getHighestSyncedBlock(1)).toBe(max);
        expect((await refresh()).summary.syncedBlockCount).toBe(7);
        db.prepare(
            "DELETE FROM collection_sync_blocks WHERE collection_id=? AND block_number=500",
        ).run(f.collectionId);
        write([700]);
        expect((await refresh()).summary.syncedBlockCount).toBe(7);
        expect(
            (
                await cache.getRangeSummary({
                    ...input,
                    fromBlock: 500,
                    toBlock: 500,
                })
            ).range.syncedBlockCount,
        ).toBe(0);
        expect(
            (
                await cache.getRangeSummary({
                    ...input,
                    fromBlock: 700,
                    toBlock: 700,
                })
            ).range.syncedBlockCount,
        ).toBe(1);
        expect(storage.captureSyncCheckpoint(1)).toEqual(before);
        expect(f.repository.getHighestSyncedBlock(1)).toBe(max);
    });

    it("reflects rollback and cannot acquire coverage from a rejected stale checkpoint", async () => {
        for (const block of [17, 100, 199, 200, 201]) write([block]);
        expect((await cache.getState(input)).summary.syncedBlockCount).toBe(5);
        const checkpoint = storage.captureSyncCheckpoint(1);
        commitRollbackFixture({
            storage,
            chainId: 1,
            fromBlock: 200,
            owners: [],
        });
        expect(() =>
            write([202], f.collectionId, undefined, checkpoint),
        ).toThrow(ChainSyncConflict);
        const updated = await refresh();
        expect(updated.summary.syncedBlockCount).toBe(3);
        expect(updated.summary.highestSyncedBlock).toBe(199);
        expect(
            (
                await cache.getRangeSummary({
                    ...input,
                    fromBlock: 200,
                    toBlock: 202,
                })
            ).range.syncedBlockCount,
        ).toBe(0);
    });

    it("recounts a retained-header reset and recent tail without treating ownership bootstrap as coverage", async () => {
        for (const block of [17, 500, 200_000]) write([block]);
        const first = await cache.getState(input);
        const checkpoint = storage.captureSyncCheckpoint(1);
        const reset = readFileSync(
            new URL(
                "../../database/migrations/067_reset_collection_sale_coverage.sql",
                import.meta.url,
            ),
            "utf8",
        );
        db.writeTransaction(() => db.exec(reset))();
        expect((await refresh()).summary.syncedBlockCount).toBe(0);
        expect(f.repository.getHighestSyncedBlock(1)).toBe(
            first.summary.highestSyncedBlock,
        );
        expect(storage.captureSyncCheckpoint(1)).toEqual(checkpoint);
        const bootstrap = new SqliteBootstrapStorage();
        const contract = loadCollection(1, f.collectionId).address;
        bootstrap.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId: f.collectionId,
                contract,
                tokenId: "1",
                owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                anchorBlock: 100,
            },
        ]);
        bootstrap.finalizeSnapshot({
            runId: 1,
            chainId: 1,
            collectionId: f.collectionId,
            contract,
            anchorBlock: 100,
            anchorHash: syncBlockFixture(100).hash,
            anchorTimestamp: 100,
        });
        expect((await refresh()).summary.syncedBlockCount).toBe(0);
        write([199_998, 199_999, 200_000]);
        expect((await refresh()).summary.syncedBlockCount).toBe(3);
        expect(
            (
                await cache.getRangeSummary({
                    ...input,
                    fromBlock: 17,
                    toBlock: 500,
                })
            ).range.syncedBlockCount,
        ).toBe(0);
    });

    it("retires a purged scope and replaces its identity on same-slug recreation", async () => {
        for (const block of [17, 500, 200_000]) write([block]);
        await cache.getState(input);
        new SqliteCollectionPurgeRepository().purgeCollectionData({
            chainId: 1,
            collectionId: f.collectionId,
        });
        vi.setSystemTime(Date.now() + REFRESH_MS);
        await cache.getState(input);
        await vi.waitFor(async () => {
            await expect(cache.getState(input)).rejects.toBeInstanceOf(
                ReadModelNotFoundError,
            );
        });
        const replacementId = f.seedCollection();
        expect(replacementId).not.toBe(f.collectionId);
        write([800], replacementId);
        vi.setSystemTime(Date.now() + REFRESH_MS);
        const replacement = await cache.getState(input);
        expect(replacement.context.collections[0].collectionId).toBe(
            replacementId,
        );
        expect(replacement.summary.syncedBlockCount).toBe(1);
    });
});
