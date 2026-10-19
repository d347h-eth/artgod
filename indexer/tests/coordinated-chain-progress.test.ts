import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    ChainSyncConflict,
    type SyncBlockHeader,
} from "../src/domain/chain-sync.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
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

    /** Fixture for evidence already produced by the ownership installer. Its
     * lease/task/snapshot verification is tested at that separate boundary. */
    function installedBase(id = collectionId, anchor = block(ANCHOR)) {
        db.prepare(
            "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,?,?,?,?)",
        ).run(
            CHAIN_ID,
            id,
            id,
            checkpoint().revision,
            anchor.number,
            anchor.hash,
        );
    }

    function readyBase() {
        initialize();
        installedBase();
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
        installedBase();
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

    it("accepts only the installed collection base at the same chain revision and identity", () => {
        initialize();
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);
        installedBase(collectionId, { ...block(900), hash: block(901).hash });
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);
        db.prepare(
            "UPDATE collection_ownership_bases SET anchor_hash=?,revision=1 WHERE collection_id=?",
        ).run(block(900).hash, collectionId);
        expect(() =>
            progress.acceptCollectionBase(
                checkpoint(),
                collectionId,
                block(900),
            ),
        ).toThrow(ChainSyncConflict);
        db.prepare(
            "UPDATE collection_ownership_bases SET revision=0 WHERE collection_id=?",
        ).run(collectionId);
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
        installedBase(joiningId, block(901));
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
