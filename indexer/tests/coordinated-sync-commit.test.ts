import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { SqliteSyncRangeCommit } from "../src/infra/storage/sqlite-sync-range-commit.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import {
    SYNC_APPLICATION_KIND,
    SYNC_WORK_COMPLETION,
} from "../src/domain/sync-work.js";
import {
    SYNC_FOLLOW_UP_KIND,
    type SyncFollowUp,
} from "../src/domain/sync-follow-ups.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { ORDER_UPDATE_REASON } from "../src/domain/order-jobs.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import type { CanonicalOrderEffectsInput } from "../src/domain/canonical-order-effects.js";
import type { SyncRangeResult } from "../src/ports/storage.js";
import {
    FINALIZED_SYNC_CHECK_POLICY,
    syncBlockFixture as block,
} from "./helpers/chain-fixture.js";
import {
    emptyOnChainData,
    insertCollection,
    loadCollection,
    selectTransferCount,
} from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN = 1;
const ANCHOR = 900;
const CONTRACT = "0x0000000000000000000000000000000000000007";
const MAKER = "0x00000000000000000000000000000000000000aa";

describe("coordinated sync writer", () => {
    loadTestEnv();
    let progress: SqliteChainProgress;
    let storage: SqliteStorage;
    let outbox: SqliteQueueOutbox;
    let collectionId: number;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        progress = new SqliteChainProgress();
        storage = new SqliteStorage();
        outbox = new SqliteQueueOutbox();
        collectionId = insertCollection({
            chainId: CHAIN,
            slug: "coordinator",
            address: CONTRACT,
            anchorBlock: ANCHOR,
        });
        const checkpoint = storage.captureSyncCheckpoint(CHAIN);
        progress.initializeChain(checkpoint, block(ANCHOR));
        db.prepare(
            "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,?,?,?,?)",
        ).run(
            CHAIN,
            collectionId,
            1,
            checkpoint.revision,
            ANCHOR,
            block(ANCHOR).hash,
        );
        progress.acceptCollectionBase(checkpoint, collectionId, block(ANCHOR));
        // A disposable projection double makes retention failure and rollback
        // visible independently of the orders adapter being integrated elsewhere.
        db.exec(
            "CREATE TABLE coordinator_effect_fixture(block_hash TEXT NOT NULL)",
        );
    });

    function result(): SyncRangeResult {
        const data = emptyOnChainData();
        const attribution = {
            blockNumber: 901,
            blockHash: block(901).hash,
            txHash: `0x${"ab".repeat(32)}`,
            logIndex: 1,
        };
        data.collectionScoped.nftTransferEvents.push({
            ...attribution,
            collectionId,
            contract: CONTRACT,
            tokenId: "1",
            from: MAKER,
            to: "0x00000000000000000000000000000000000000bb",
            amount: "1",
            kind: COLLECTION_STANDARD.Erc721,
        });
        data.global.cancelEvents.push({
            ...attribution,
            orderId: "cancelled-order",
        });
        data.global.makerTriggers.push({
            ...attribution,
            logIndex: 2,
            maker: MAKER,
            reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
        });
        return {
            checkpoint: storage.captureSyncCheckpoint(CHAIN),
            application: {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: progress.chainProgress(CHAIN),
                collections: [
                    progress.collectionProgress(CHAIN, collectionId)!,
                ],
            },
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            blocks: [block(901)],
            collections: [loadCollection(CHAIN, collectionId)],
            data,
        };
    }

    function followUp(): SyncFollowUp {
        return {
            kind: SYNC_FOLLOW_UP_KIND.Range,
            job: {
                jobId: "coordinated-sync-follow-up",
                kind: DOMAIN_JOB_KIND.ActivitySync,
                queue: QUEUE_NAMES.ActivityDomain,
                chainId: CHAIN,
                collectionId,
                scheduledAt: 100,
                attempt: 0,
                payload: {
                    chainId: CHAIN,
                    collectionId,
                    fromBlock: 901,
                    toBlock: 901,
                },
            },
        };
    }

    function commit(retain: (input: CanonicalOrderEffectsInput) => void) {
        return new SqliteSyncRangeCommit({
            storage,
            progress,
            outbox,
            orderEffects: { retain },
            collections: new SqliteCollectionRegistry(),
            gaps: {
                getProgress: () => {
                    throw new Error("Unexpected historical gap lookup");
                },
                recordRepairProgress: () => {
                    throw new Error("Unexpected historical gap completion");
                },
            },
            recoveries: {
                getRecovery: () => null,
                completeResyncRange: () => {
                    throw new Error("Unexpected recovery completion");
                },
            },
            now: () => 100,
        });
    }

    function retain(input: CanonicalOrderEffectsInput) {
        expect(db.raw.inTransaction).toBe(true);
        expect(progress.chainProgress(CHAIN)?.applied.number).toBe(900);
        expect(storage.getBlockHash(CHAIN, 901)).toBe(block(901).hash);
        for (const effect of input.effects)
            db.prepare(
                "INSERT INTO coordinator_effect_fixture(block_hash) VALUES (?)",
            ).run(effect.payload.blockHash);
    }

    function assertUncommitted() {
        expect(progress.chainProgress(CHAIN)?.applied.number).toBe(900);
        expect(
            progress.collectionProgress(CHAIN, collectionId)?.applied.number,
        ).toBe(900);
        expect(storage.getBlockHash(CHAIN, 901)).toBeNull();
        expect(selectTransferCount(CHAIN, collectionId, "1")).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM coordinator_effect_fixture",
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
    }

    it("persists critical effects before advancing either prefix and retaining publication intent", () => {
        const writer = commit(retain);
        const actualEnqueue = outbox.enqueueSyncFollowUp.bind(outbox);
        vi.spyOn(outbox, "enqueueSyncFollowUp").mockImplementation((input) => {
            expect(
                progress.validationCheckpoint(CHAIN, collectionId)?.block
                    .number,
            ).toBe(901);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM coordinator_effect_fixture",
                    )
                    .get(),
            ).toEqual({ count: 2 });
            return actualEnqueue(input);
        });
        writer.commitSyncRange({
            result: result(),
            followUps: [followUp()],
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        expect(
            progress.validationCheckpoint(CHAIN, collectionId)?.block.number,
        ).toBe(901);
        expect(selectTransferCount(CHAIN, collectionId, "1")).toBe(1);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 1 });
    });

    it.each(["critical effect", "publication"])(
        "rolls back facts, effects and progress when %s retention fails",
        (failure) => {
            if (failure === "publication")
                db.exec(
                    "CREATE TEMP TRIGGER reject_coordinated_outbox BEFORE INSERT ON queue_outbox BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END;",
                );
            const writer = commit((input) => {
                retain(input);
                if (failure === "critical effect")
                    throw new Error("fixture critical effect failure");
            });
            expect(() =>
                writer.commitSyncRange({
                    result: result(),
                    followUps: [followUp()],
                    completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
                }),
            ).toThrow("fixture");
            assertUncommitted();
        },
    );

    it("rejects a missing predecessor before persisting any candidate fact", () => {
        const acquired = result();
        acquired.blocks = [block(902)];
        const effects = vi.fn();
        expect(() =>
            commit(effects).commitSyncRange({
                result: acquired,
                followUps: [],
                completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
            }),
        ).toThrow(ChainSyncConflict);
        expect(effects).not.toHaveBeenCalled();
        assertUncommitted();
    });

    it("retains global effects on shared-only advancement with no collection scope", () => {
        const acquired = result();
        acquired.application = {
            kind: SYNC_APPLICATION_KIND.Applied,
            chain: progress.chainProgress(CHAIN),
            collections: [],
        };
        acquired.collections = [];
        acquired.data.collectionScoped.nftTransferEvents = [];
        const effects = vi.fn(retain);
        commit(effects).commitSyncRange({
            result: acquired,
            followUps: [],
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        expect(
            effects.mock.calls[0]![0].effects.map(
                (effect) => effect.payload.reason,
            ),
        ).toEqual([
            GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            ORDER_UPDATE_REASON.Cancel,
        ]);
        expect(progress.chainProgress(CHAIN)?.applied.number).toBe(901);
        expect(
            progress.collectionProgress(CHAIN, collectionId)?.applied.number,
        ).toBe(900);
    });

    it.each([false, true])(
        "replays collection effects without repeating global effects (recovery resync: %s)",
        (recovering) => {
            const shared = result();
            shared.application = {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: progress.chainProgress(CHAIN),
                collections: [],
            };
            shared.collections = [];
            shared.data.collectionScoped.nftTransferEvents = [];
            commit(retain).commitSyncRange({
                result: shared,
                followUps: [],
                completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
            });
            if (recovering)
                db.prepare(
                    "INSERT INTO chain_reorg_recoveries(chain_id,recovery_id,version,revision,checked_block,stored_hash,observed_hash,phase,retry_at,range_from,range_to,target_block) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ).run(
                    CHAIN,
                    "fixture-recovery",
                    1,
                    0,
                    901,
                    block(1901).hash,
                    block(901).hash,
                    REORG_RECOVERY_PHASE.Resync,
                    0,
                    901,
                    901,
                    901,
                );
            const collectionOnly = result();
            collectionOnly.application = {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: null,
                collections: [
                    progress.collectionProgress(CHAIN, collectionId)!,
                ],
            };
            const effects = vi.fn();
            commit(effects).commitSyncRange({
                result: collectionOnly,
                followUps: [],
                completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
            });
            expect(effects.mock.calls[0]![0].effects).toEqual([]);
            expect(
                progress.collectionProgress(CHAIN, collectionId)?.applied
                    .number,
            ).toBe(901);
            if (recovering)
                expect(
                    progress.validationCheckpoint(CHAIN, collectionId),
                ).toBeNull();
            else
                expect(
                    progress.validationCheckpoint(CHAIN, collectionId)?.block
                        .number,
                ).toBe(901);
        },
    );

    it("keeps historical facts separate from current effects and cannot import beyond applied history", () => {
        const acquired = result();
        acquired.application = { kind: SYNC_APPLICATION_KIND.Historical };
        const effects = vi.fn();
        const writer = commit(effects);
        expect(() =>
            writer.commitSyncRange({
                result: acquired,
                followUps: [],
                completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
            }),
        ).toThrow(ChainSyncConflict);
        assertUncommitted();
        acquired.blocks = [block(899)];
        acquired.data = emptyOnChainData();
        writer.commitSyncRange({
            result: acquired,
            followUps: [],
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        expect(storage.getBlockHash(CHAIN, 899)).toBe(block(899).hash);
        expect(
            progress.validationCheckpoint(CHAIN, collectionId)?.block.number,
        ).toBe(900);
        expect(effects).not.toHaveBeenCalled();
    });
});
