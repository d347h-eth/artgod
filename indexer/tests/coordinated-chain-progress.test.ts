import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    ChainSyncConflict,
    type SyncBlockHeader,
} from "../src/domain/chain-sync.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { SqliteCanonicalChecks } from "../src/infra/storage/sqlite-canonical-checks.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { persistCanonicalBlocks } from "../src/infra/storage/sqlite-canonical-headers.js";
import {
    advanceChainSyncRevision,
    captureChainSyncCheckpoint,
} from "../src/infra/storage/sqlite-chain-revisions.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN_ID = 1;
const ANCHOR = 900;
const block = syncBlockFixture;

/** These tests exercise the applied-progress storage boundary, not the complete
 * coordinator/order pipeline. The coordinator's effects writer is represented
 * by canonical header persistence and cursor advancement in one transaction. */
describe("durable coordinated chain progress", () => {
    loadTestEnv();
    let databasePath: string;
    let progress: SqliteChainProgress;
    let collectionId: number;

    beforeEach(async () => {
        databasePath = await createTempDbPath();
        setDbPath(databasePath);
        await createMigrationRunner().runMigrations();
        progress = new SqliteChainProgress();
        collectionId = addCollection("established", ANCHOR);
    });

    function addCollection(slug: string, anchor: number): number {
        return insertCollection({
            chainId: CHAIN_ID,
            slug,
            address: `0x${slug === "established" ? "aa" : "bb"}`.padEnd(
                42,
                "0",
            ),
            anchorBlock: anchor,
        });
    }

    function checkpoint() {
        return captureChainSyncCheckpoint(CHAIN_ID);
    }

    function initialize() {
        progress.initializeChain(checkpoint(), block(ANCHOR));
    }

    function readyBase() {
        initialize();
        progress.acceptCollectionBase(
            checkpoint(),
            collectionId,
            block(ANCHOR),
        );
    }

    function headers(from: number, to: number): SyncBlockHeader[] {
        return Array.from({ length: to - from + 1 }, (_, index) =>
            block(from + index),
        );
    }

    function commitChain(blocks: readonly SyncBlockHeader[]) {
        const expected = progress.chainProgress(CHAIN_ID)!;
        db.writeTransaction(() => {
            progress.assertChainRange(expected, blocks);
            persistCanonicalBlocks(checkpoint(), blocks, () => false);
            progress.advanceChain(expected, blocks);
        })();
    }

    function commitCollection(id: number, blocks: readonly SyncBlockHeader[]) {
        const expected = progress.collectionProgress(CHAIN_ID, id)!;
        db.writeTransaction(() =>
            progress.advanceCollection(expected, blocks),
        )();
    }

    function admissionSequence(sequence: number) {
        // M3 admission owns this monotonic counter. Direct fixture writes keep
        // this storage-level test independent of the not-yet-wired consumer.
        db.prepare(
            "INSERT INTO chain_sync_revisions(chain_id,revision,admission_sequence) VALUES (?,0,?) ON CONFLICT(chain_id) DO UPDATE SET admission_sequence=excluded.admission_sequence",
        ).run(CHAIN_ID, sequence);
    }

    it("does not derive readiness or an applied cursor from sparse stored headers", () => {
        db.writeTransaction(() =>
            persistCanonicalBlocks(
                checkpoint(),
                [block(900), block(1000)],
                () => false,
            ),
        )();
        expect(progress.chainProgress(CHAIN_ID)).toBeNull();
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toBeNull();
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);

        initialize();
        progress.acceptCollectionBase(checkpoint(), collectionId, block(900));
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(900);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, {
                chainId: CHAIN_ID,
                blockNumber: 1000,
                blockHash: block(1000).hash,
            }),
        ).toBeNull();
    });

    it("accepts a live collection only at its declared anchor and current chain revision", () => {
        initialize();
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Bootstrapping,
            collectionId,
        );
        // A bootstrapping status alone grants no collection catch-up authority.
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Live,
            collectionId,
        );
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(899),
            ),
        ).toThrow(ChainSyncConflict);
        expect(() =>
            progress.acceptCollectionBase(checkpoint(), collectionId, {
                ...block(900),
                hash: block(901).hash,
            }),
        ).toThrow(ChainSyncConflict);
        expect(() =>
            progress.acceptCollectionBase(
                { ...checkpoint(), revision: 1 },
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);
        progress.acceptCollectionBase(checkpoint(), collectionId, block(900));
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(900);
    });

    it("requires contiguous chain and collection application before a sampled target becomes usable", () => {
        readyBase();
        admissionSequence(1);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(1000),
            10,
        );
        const barrier = progress.admissionBarrier(CHAIN_ID, 1)!;
        expect(progress.headTarget(CHAIN_ID)?.blockNumber).toBe(1000);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, barrier),
        ).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT 1 FROM blocks WHERE chain_id=? AND block_number=1000",
                )
                .get(CHAIN_ID),
        ).toBeUndefined();

        commitChain(headers(901, 1000));
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, barrier),
        ).toBeNull();
        commitCollection(collectionId, headers(901, 999));
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(999);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, barrier),
        ).toBeNull();
        commitCollection(collectionId, [block(1000)]);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, barrier),
        ).toMatchObject({
            revision: 0,
            block: { number: 1000, hash: block(1000).hash },
        });
    });

    it("does not cover an admission arriving after head acquisition begins", () => {
        readyBase();
        admissionSequence(1);
        const begunBeforeSecondHint = progress.captureHeadSample(CHAIN_ID);
        admissionSequence(2);
        progress.recordHeadSample(begunBeforeSecondHint, block(1000), 10);
        expect(progress.admissionBarrier(CHAIN_ID, 1)?.blockNumber).toBe(1000);
        expect(progress.admissionBarrier(CHAIN_ID, 2)).toBeNull();

        // A later sample at a stationary HEAD is sufficient; mining is not a
        // prerequisite for establishing observation-after-admission ordering.
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(1000),
            11,
        );
        expect(progress.admissionBarrier(CHAIN_ID, 2)?.sampledAt).toBe(11);
    });

    it("does not move an admitted generation's finishing line when HEAD advances", () => {
        readyBase();
        admissionSequence(1);
        const request = progress.captureHeadSample(CHAIN_ID);
        progress.recordHeadSample(request, block(1000), 10);
        progress.recordHeadSample(request, block(1001), 11);
        expect(progress.headTarget(CHAIN_ID)?.blockNumber).toBe(1001);
        expect(progress.admissionBarrier(CHAIN_ID, 1)?.blockNumber).toBe(1000);
    });

    it("binds a replaced unaccepted target to the applied branch without moving its height", () => {
        readyBase();
        admissionSequence(1);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(901),
            10,
        );
        const replacement = { ...block(901), hash: `0x${"ab".repeat(32)}` };
        expect(() =>
            progress.assertValidationCheckpoint({
                ...checkpoint(),
                collectionId,
                block: block(901),
            }),
        ).toThrow(ChainSyncConflict);
        commitChain([replacement]);
        commitCollection(collectionId, [replacement]);
        const rebound = progress.admissionBarrier(CHAIN_ID, 1)!;
        expect(rebound).toMatchObject({
            blockNumber: 901,
            blockHash: replacement.hash,
        });
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, rebound)
                ?.block.hash,
        ).toBe(replacement.hash);
        expect(() =>
            progress.assertValidationCheckpoint({
                ...checkpoint(),
                collectionId,
                block: block(901),
            }),
        ).toThrow(ChainSyncConflict);
    });

    it("gates a late conflicting sample until fresh confirmation repairs its barrier", () => {
        readyBase();
        admissionSequence(1);
        const request = progress.captureHeadSample(CHAIN_ID);
        commitChain([block(901)]);
        commitCollection(collectionId, [block(901)]);
        progress.recordHeadSample(
            request,
            { ...block(901), hash: `0x${"ab".repeat(32)}` },
            10,
        );
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toBeNull();
        expect(() => commitChain([block(902)])).toThrow(ChainSyncConflict);
        const checks = new SqliteCanonicalChecks();
        const claim = checks.nextDue({
            chainId: CHAIN_ID,
            now: 11,
            upperBound: 0,
        })!;
        expect(claim).toMatchObject({ blockNumber: 901, generation: 1 });
        // A successful later sample cannot move the frozen finishing line.
        progress.recordHeadSample(request, block(902), 11);
        expect(progress.admissionBarrier(CHAIN_ID, 1)?.blockHash).not.toBe(
            block(901).hash,
        );
        expect(checks.confirmCanonicalBlock(claim)).toBe(true);
        expect(progress.admissionBarrier(CHAIN_ID, 1)).toMatchObject({
            blockNumber: 901,
            blockHash: block(901).hash,
        });
        expect(
            progress.validationCheckpoint(
                CHAIN_ID,
                collectionId,
                progress.admissionBarrier(CHAIN_ID, 1),
            )?.block.number,
        ).toBe(901);
        commitChain([block(902)]);
    });

    it("cannot clear a newer dispute with an older confirmation or retry", () => {
        readyBase();
        commitChain([block(901)]);
        commitCollection(collectionId, [block(901)]);
        const check = {
            chainId: CHAIN_ID,
            checkpoint: checkpoint(),
            blockNumber: 901,
            blockHash: block(901).hash,
        };
        progress.retainDispute(check);
        const checks = new SqliteCanonicalChecks();
        const old = checks.nextDue({
            chainId: CHAIN_ID,
            now: 10,
            upperBound: 0,
        })!;
        progress.retainDispute(check);
        expect(checks.confirmCanonicalBlock(old)).toBe(false);
        checks.defer(old, 1000);
        const current = checks.nextDue({
            chainId: CHAIN_ID,
            now: 10,
            upperBound: 0,
        })!;
        expect(current.generation).toBe(2);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toBeNull();
        expect(checks.confirmCanonicalBlock(current)).toBe(true);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(901);
    });

    it("clears only the confirmed dispute while other heights remain gated", () => {
        readyBase();
        commitChain(headers(901, 902));
        commitCollection(collectionId, headers(901, 902));
        for (const number of [901, 902])
            progress.retainDispute({
                chainId: CHAIN_ID,
                checkpoint: checkpoint(),
                blockNumber: number,
                blockHash: block(number).hash,
            });
        const checks = new SqliteCanonicalChecks();
        expect(
            checks.confirmCanonicalBlock(
                checks.nextDue({ chainId: CHAIN_ID, now: 10, upperBound: 0 })!,
            ),
        ).toBe(true);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT disputed_from FROM chain_sync_progress WHERE chain_id=1",
                )
                .get(),
        ).toEqual({ disputed_from: 902 });
        expect(
            checks.confirmCanonicalBlock(
                checks.nextDue({ chainId: CHAIN_ID, now: 10, upperBound: 0 })!,
            ),
        ).toBe(true);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(902);
    });

    it("rejects a lagging below-base sample without freezing its admission mapping", () => {
        readyBase();
        admissionSequence(1);
        const request = progress.captureHeadSample(CHAIN_ID);
        expect(() =>
            progress.recordHeadSample(request, block(899), 10),
        ).toThrow(ChainSyncConflict);
        expect(progress.admissionBarrier(CHAIN_ID, 1)).toBeNull();
        progress.recordHeadSample(request, block(900), 11);
        expect(
            progress.validationCheckpoint(
                CHAIN_ID,
                collectionId,
                progress.admissionBarrier(CHAIN_ID, 1),
            )?.block.number,
        ).toBe(900);
    });

    it("discards below-base mappings retained before explicit initialization", () => {
        admissionSequence(1);
        const request = progress.captureHeadSample(CHAIN_ID);
        progress.recordHeadSample(request, block(899), 10);
        readyBase();
        expect(progress.admissionBarrier(CHAIN_ID, 1)).toBeNull();
        expect(progress.headTarget(CHAIN_ID)).toBeNull();
        progress.recordHeadSample(request, block(900), 11);
        expect(
            progress.validationCheckpoint(
                CHAIN_ID,
                collectionId,
                progress.admissionBarrier(CHAIN_ID, 1),
            )?.block.number,
        ).toBe(900);
    });

    it("retains a dispute when initialization overtakes a conflicting anchor sample", () => {
        admissionSequence(1);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            { ...block(900), hash: `0x${"ab".repeat(32)}` },
            10,
        );
        initialize();
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);
        const checks = new SqliteCanonicalChecks();
        checks.confirmCanonicalBlock(
            checks.nextDue({ chainId: CHAIN_ID, now: 11, upperBound: 0 })!,
        );
        progress.acceptCollectionBase(checkpoint(), collectionId, block(900));
        expect(
            progress.validationCheckpoint(
                CHAIN_ID,
                collectionId,
                progress.admissionBarrier(CHAIN_ID, 1),
            )?.block.number,
        ).toBe(900);
    });

    it("ignores a late smaller watermark instead of remapping covered admissions", () => {
        readyBase();
        admissionSequence(1);
        const earlier = progress.captureHeadSample(CHAIN_ID);
        admissionSequence(2);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(901),
            10,
        );
        progress.recordHeadSample(earlier, block(902), 11);
        expect(progress.admissionBarrier(CHAIN_ID, 1)).toMatchObject({
            blockNumber: 901,
            sampledAt: 10,
        });
        expect(progress.admissionBarrier(CHAIN_ID, 2)).toMatchObject({
            blockNumber: 901,
            sampledAt: 10,
        });
        expect(progress.headTarget(CHAIN_ID)?.blockNumber).toBe(901);
    });

    it("indexes sample rebinding by the one accepted block", () => {
        const plan = db
            .prepare(
                "EXPLAIN QUERY PLAN UPDATE chain_head_samples SET block_hash=? WHERE chain_id=? AND revision=? AND block_number=? AND block_hash<>?",
            )
            .all(block(901).hash, CHAIN_ID, 0, 901, block(901).hash) as Array<{
            detail: string;
        }>;
        expect(
            plan.some(
                (row) =>
                    row.detail.includes("chain_head_samples_block") &&
                    row.detail.includes("block_number=?"),
            ),
        ).toBe(true);
    });

    it("allows exact accepted collection replay during resync while history remains gated", () => {
        readyBase();
        commitChain([block(901)]);
        db.prepare(
            "INSERT INTO chain_reorg_recoveries(chain_id,recovery_id,version,revision,checked_block,stored_hash,observed_hash,phase,retry_at,range_from,range_to,target_block) VALUES (1,'replay',0,0,901,'old','new',?,0,901,901,901)",
        ).run(REORG_RECOVERY_PHASE.Resync);
        expect(() =>
            progress.assertCollectionReplayRange(checkpoint(), [block(901)]),
        ).not.toThrow();
        expect(() =>
            progress.assertHistoricalRange(checkpoint(), [block(901)]),
        ).toThrow(ChainSyncConflict);
        expect(() =>
            progress.assertCollectionReplayRange(checkpoint(), [block(902)]),
        ).toThrow(ChainSyncConflict);
        expect(() =>
            progress.assertCollectionReplayRange(checkpoint(), [
                { ...block(901), hash: "other" },
            ]),
        ).toThrow(ChainSyncConflict);
    });

    it("cannot publish applied progress outside the core effects writer", () => {
        readyBase();
        const expected = progress.chainProgress(CHAIN_ID)!;
        expect(() => progress.advanceChain(expected, [block(901)])).toThrow(
            ChainSyncConflict,
        );
        expect(progress.chainProgress(CHAIN_ID)?.applied.number).toBe(900);
    });

    it.each([
        ["missing predecessor", [block(902)]],
        ["internal gap", [block(901), block(903)]],
        ["wrong parent", [{ ...block(901), parentHash: block(899).hash }]],
    ] as const)(
        "rejects %s without retaining candidate effects or advancing progress",
        (_, candidate) => {
            readyBase();
            expect(() => commitChain(candidate)).toThrow(ChainSyncConflict);
            expect(progress.chainProgress(CHAIN_ID)?.applied.number).toBe(900);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM blocks WHERE chain_id=? AND block_number>900",
                    )
                    .get(CHAIN_ID),
            ).toEqual({ count: 0 });
        },
    );

    it("does not advance a collection beyond shared effects or skip its own missing predecessor", () => {
        readyBase();
        expect(() => commitCollection(collectionId, [block(901)])).toThrow(
            ChainSyncConflict,
        );
        commitChain(headers(901, 902));
        expect(() => commitCollection(collectionId, [block(902)])).toThrow(
            ChainSyncConflict,
        );
        expect(
            progress.collectionProgress(CHAIN_ID, collectionId)?.applied.number,
        ).toBe(900);
    });

    it("lets an established scope progress while a joining collection waits for its base and catch-up", () => {
        readyBase();
        commitChain(headers(901, 902));
        commitCollection(collectionId, headers(901, 902));
        const joiningId = addCollection("joining", 901);
        expect(progress.validationCheckpoint(CHAIN_ID, joiningId)).toBeNull();
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(902);
        progress.acceptCollectionBase(checkpoint(), joiningId, block(901));
        expect(
            progress.validationCheckpoint(CHAIN_ID, joiningId)?.block.number,
        ).toBe(901);
        commitChain([block(903)]);
        commitCollection(collectionId, [block(903)]);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(903);
        expect(
            progress.validationCheckpoint(CHAIN_ID, joiningId)?.block.number,
        ).toBe(901);
    });

    it("gates existing proof and forward commits immediately when a dispute is retained", () => {
        readyBase();
        commitChain([block(901)]);
        commitCollection(collectionId, [block(901)]);
        const usable = progress.validationCheckpoint(CHAIN_ID, collectionId)!;
        progress.retainDispute({
            chainId: CHAIN_ID,
            checkpoint: checkpoint(),
            blockNumber: 901,
            blockHash: block(901).hash,
        });
        expect(checkpoint().revision).toBe(0);
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toBeNull();
        expect(() => progress.assertValidationCheckpoint(usable)).toThrow(
            ChainSyncConflict,
        );
        expect(() => commitChain([block(902)])).toThrow(ChainSyncConflict);
        setDbPath(databasePath);
        progress = new SqliteChainProgress();
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toBeNull();
    });

    it("binds an unaccepted sampled target to the replacement branch without moving its height", () => {
        readyBase();
        admissionSequence(1);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(901),
            10,
        );
        const originalBarrier = progress.admissionBarrier(CHAIN_ID, 1)!;
        expect(
            progress.validationCheckpoint(
                CHAIN_ID,
                collectionId,
                originalBarrier,
            ),
        ).toBeNull();
        const replacement = { ...block(901), hash: block(1901).hash };
        commitChain([replacement]);
        commitCollection(collectionId, [replacement]);
        const rebound = progress.admissionBarrier(CHAIN_ID, 1)!;
        expect(rebound).toMatchObject({
            blockNumber: 901,
            blockHash: replacement.hash,
            revision: 0,
        });
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId, rebound)
                ?.block,
        ).toEqual({
            number: replacement.number,
            hash: replacement.hash,
            parentHash: replacement.parentHash,
            timestamp: replacement.timestamp,
        });
        expect(
            progress.validationCheckpoint(
                CHAIN_ID,
                collectionId,
                originalBarrier,
            ),
        ).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT 1 FROM blocks WHERE chain_id=? AND block_hash=?",
                )
                .get(CHAIN_ID, originalBarrier.blockHash),
        ).toBeUndefined();
    });

    it("retains applied progress and admission barriers across a closed connection", () => {
        readyBase();
        commitChain([block(901)]);
        commitCollection(collectionId, [block(901)]);
        admissionSequence(1);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(902),
            10,
        );
        setDbPath(databasePath);
        progress = new SqliteChainProgress();
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId)?.block.number,
        ).toBe(901);
        expect(progress.admissionBarrier(CHAIN_ID, 1)?.blockNumber).toBe(902);
    });

    it("rewinds after orphan deletion and revision advance without reusing old samples or proofs", () => {
        readyBase();
        commitChain(headers(901, 902));
        commitCollection(collectionId, headers(901, 902));
        admissionSequence(1);
        const oldRequest = progress.captureHeadSample(CHAIN_ID);
        progress.recordHeadSample(oldRequest, block(902), 10);
        const oldProof = progress.validationCheckpoint(CHAIN_ID, collectionId)!;
        progress.retainDispute({
            chainId: CHAIN_ID,
            checkpoint: checkpoint(),
            blockNumber: 902,
            blockHash: block(902).hash,
        });

        db.writeTransaction(() => {
            db.prepare(
                "DELETE FROM blocks WHERE chain_id=? AND block_number>901",
            ).run(CHAIN_ID);
            advanceChainSyncRevision(CHAIN_ID);
            progress.rewindAfterRollback(CHAIN_ID, block(901));
        })();

        expect(progress.chainProgress(CHAIN_ID)).toMatchObject({
            checkpoint: { revision: 1 },
            applied: { number: 901 },
        });
        expect(
            progress.validationCheckpoint(CHAIN_ID, collectionId),
        ).toMatchObject({ revision: 1, block: { number: 901 } });
        expect(progress.headTarget(CHAIN_ID)).toBeNull();
        expect(progress.admissionBarrier(CHAIN_ID, 1)).toBeNull();
        expect(() => progress.assertValidationCheckpoint(oldProof)).toThrow(
            ChainSyncConflict,
        );
        expect(() =>
            progress.recordHeadSample(oldRequest, block(902), 11),
        ).toThrow(ChainSyncConflict);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN_ID),
            block(901),
            12,
        );
        expect(progress.admissionBarrier(CHAIN_ID, 1)).toMatchObject({
            revision: 1,
            blockNumber: 901,
        });
    });
});
