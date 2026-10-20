import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { findCommonAncestor } from "../src/application/reorg-fork.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { MAKER_REVALIDATION_STATUS } from "../src/domain/maker-revalidation.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { SqliteCanonicalChecks } from "../src/infra/storage/sqlite-canonical-checks.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import {
    insertCollection,
    loadCollection,
} from "./helpers/ownership-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN = 1;
const NOW = 1_800_000_000_000;

describe("accepted lineage and admission retention", () => {
    loadTestEnv();
    let collectionId: number;
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        collectionId = insertCollection({
            chainId: CHAIN,
            slug: "retention",
            address: "0x0000000000000000000000000000000000000001",
            anchorBlock: 900,
        });
    });

    function fixture(to = 905) {
        const work = createAppliedSyncFixture({
            chainId: CHAIN,
            anchor: block(900),
            collections: [loadCollection(CHAIN, collectionId)],
        });
        work.commit(
            work.applied({
                blocks: Array.from({ length: to - 900 }, (_, offset) =>
                    block(901 + offset),
                ),
                shared: true,
                collectionIds: [collectionId],
            }),
        );
        return work;
    }

    it("clamps ancestry to the accepted base and preserves delayed-check history while HEAD advances", async () => {
        const f = fixture(1100);
        const check = {
            checkpoint: f.storage.captureSyncCheckpoint(CHAIN),
            chainId: CHAIN,
            blockNumber: 905,
            blockHash: block(905).hash,
        };
        const checks = new SqliteCanonicalChecks();
        checks.retain(check);
        checks.defer(check, NOW + 10_000);
        f.progress.recordHeadSample(
            f.progress.captureHeadSample(CHAIN),
            block(1100),
            NOW,
        );
        new SqliteMarketDataMaintenance(db).maintainBatch(NOW / 1000);
        expect(
            f.storage.captureReorgHistory({
                chainId: CHAIN,
                fromBlock: 895,
                toBlock: 905,
            }),
        ).toMatchObject({
            fromBlock: 900,
            headers: Array.from({ length: 6 }, (_, i) => {
                const { transactions: _transactions, ...header } = block(
                    900 + i,
                );
                return header;
            }),
        });
        expect(
            db
                .prepare(
                    "SELECT canonical_check_pending FROM blocks WHERE chain_id=? AND block_number=?",
                )
                .get(CHAIN, 905),
        ).toEqual({ canonical_check_pending: 1 });
        const proof = await findCommonAncestor({
            storage: f.storage,
            rpc: {
                getBlock: async (number) =>
                    number === 905
                        ? { ...block(number), hash: block(1905).hash }
                        : block(number),
            },
            chainId: CHAIN,
            startBlock: 905,
            reorgDepth: 10,
        });
        expect(proof).toMatchObject({ fork: { number: 904 } });
    });

    it.each(["missing", "disconnected"] as const)(
        "rejects %s local lineage before replacement RPC",
        async (damage) => {
            const f = fixture();
            if (damage === "missing")
                db.prepare(
                    "DELETE FROM blocks WHERE chain_id=? AND block_number=?",
                ).run(CHAIN, 903);
            else
                db.prepare(
                    "UPDATE blocks SET parent_hash=? WHERE chain_id=? AND block_number=?",
                ).run(block(2000).hash, CHAIN, 903);
            const rpc = {
                getBlock: vi.fn(async (number: number) => block(number)),
            };
            await expect(
                findCommonAncestor({
                    storage: f.storage,
                    rpc,
                    chainId: CHAIN,
                    startBlock: 905,
                    reorgDepth: 5,
                }),
            ).rejects.toBeInstanceOf(ChainSyncConflict);
            expect(rpc.getBlock).not.toHaveBeenCalled();
        },
    );

    it("rejects headers outside the applied prefix and does not recover across a replaced base", async () => {
        const f = fixture();
        expect(() =>
            f.storage.captureReorgHistory({
                chainId: CHAIN,
                fromBlock: 904,
                toBlock: 906,
            }),
        ).toThrow(ChainSyncConflict);
        expect(() =>
            f.storage.captureReorgHistory({
                chainId: CHAIN,
                fromBlock: 890,
                toBlock: 899,
            }),
        ).toThrow(ChainSyncConflict);
        const rpc = {
            getBlock: async (number: number) => ({
                ...block(number),
                hash: block(number + 1000).hash,
                parentHash: block(number + 999).hash,
            }),
        };
        expect(
            await findCommonAncestor({
                storage: f.storage,
                rpc,
                chainId: CHAIN,
                startBlock: 905,
                reorgDepth: 5,
            }),
        ).toBeNull();
        expect(
            await findCommonAncestor({
                storage: f.storage,
                rpc,
                chainId: CHAIN,
                startBlock: 900,
                reorgDepth: 5,
            }),
        ).toBeNull();
    });

    it("does not let a merely selected joining anchor block recovery of accepted state", () => {
        const f = fixture();
        insertCollection({
            chainId: CHAIN,
            slug: "selected-only",
            address: "0x0000000000000000000000000000000000000002",
            anchorBlock: 1000,
        });
        expect(
            f.storage.prepareRollback({ chainId: CHAIN, fromBlock: 904 }),
        ).toMatchObject({ fromBlock: 904 });
    });

    it("protects an installed joining snapshot even before coordinator acceptance", () => {
        const f = fixture();
        const joining = insertCollection({
            chainId: CHAIN,
            slug: "installed-only",
            address: "0x0000000000000000000000000000000000000002",
            anchorBlock: 1000,
        });
        db.prepare(
            "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,1,0,1000,?)",
        ).run(CHAIN, joining, block(1000).hash);
        expect(f.progress.collectionProgress(CHAIN, joining)).toBeNull();
        expect(() =>
            f.storage.prepareRollback({ chainId: CHAIN, fromBlock: 904 }),
        ).toThrow("crosses retained applied base 1000");
    });

    it("protects the shared accepted base after the last collection is removed", () => {
        const f = fixture();
        db.prepare("DELETE FROM collections WHERE collection_id=?").run(
            collectionId,
        );
        expect(() =>
            f.storage.prepareRollback({ chainId: CHAIN, fromBlock: 900 }),
        ).toThrow("crosses retained applied base 900");
    });

    function sample(progress: SqliteChainProgress, sequence: number) {
        db.prepare(
            "INSERT INTO chain_sync_revisions(chain_id,revision,admission_sequence) VALUES (?,0,?) ON CONFLICT(chain_id) DO UPDATE SET admission_sequence=excluded.admission_sequence",
        ).run(CHAIN, sequence);
        progress.recordHeadSample(
            progress.captureHeadSample(CHAIN),
            block(900 + sequence),
            NOW,
        );
    }

    function demand(id: string, sequence: number, pending = 1) {
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,valid_until,fillability_status,source_status) VALUES (?,?,?,'seaport','maker','contract',?,?,?)",
        ).run(
            id,
            CHAIN,
            collectionId,
            NOW / 1000 + 100_000,
            ORDER_STATUS.Unvalidated,
            ORDER_SOURCE_STATUS.Active,
        );
        db.prepare(
            "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,updated_at,admission_sequence,pending) VALUES (?,?,0,?,?,?,?)",
        ).run(id, CHAIN, NOW, NOW, sequence, pending);
    }

    function pendingMaker(sequence: number, requested: number) {
        db.prepare(
            "INSERT INTO maker_order_revalidation_runs(run_id,chain_id,source_job_id,payload_json,status,upper_order_id,upper_rowid,created_at,updated_at,admission_sequence,requested_admission_sequence) VALUES ('maker',?,'maker-source','{}',?,'',0,?,?,?,?)",
        ).run(
            CHAIN,
            MAKER_REVALIDATION_STATUS.Pending,
            NOW,
            NOW,
            sequence,
            requested,
        );
    }

    function remaining() {
        return db
            .prepare(
                "SELECT revision,admission_watermark AS watermark FROM chain_head_samples ORDER BY revision,admission_watermark",
            )
            .all();
    }

    function drain(progress: SqliteChainProgress, now = NOW) {
        for (let n = 0; n < 100; n++)
            if (
                !progress.pruneHeadSamples({
                    now,
                    limit: MARKET_DATA_STORAGE_POLICY.maintenanceBatchRows,
                }).examined
            )
                return;
        throw new Error("Sample cleanup did not finish its bounded pass");
    }

    it("preserves exact pending, claim and maker interval mappings; committed proof scalars do not pin obsolete samples", () => {
        const progress = new SqliteChainProgress();
        for (let sequence = 10; sequence <= 80; sequence += 10)
            sample(progress, sequence);
        demand("pending", 11);
        demand("claimed", 0, 0);
        db.prepare(
            "UPDATE order_validation_demand SET claim_admission_sequence=21,claim_chain_revision=0,lease_owner='worker',lease_until=? WHERE order_id='claimed'",
        ).run(NOW + 1000);
        pendingMaker(31, 41);
        demand("proved", 0, 0);
        db.prepare(
            "UPDATE order_validation_demand SET proof_admission_sequence=51,proof_chain_revision=0,proof_block=960,proof_block_hash=? WHERE order_id='proved'",
        ).run(block(960).hash);
        const before = [11, 21, 31, 41].map((sequence) =>
            progress.admissionBarrier(CHAIN, sequence),
        );
        drain(progress);
        expect(remaining()).toEqual(
            [20, 30, 40, 50, 80].map((watermark) => ({
                revision: 0,
                watermark,
            })),
        );
        expect(
            [11, 21, 31, 41].map((sequence) =>
                progress.admissionBarrier(CHAIN, sequence),
            ),
        ).toEqual(before);

        db.prepare("UPDATE maker_order_revalidation_runs SET status=?").run(
            MAKER_REVALIDATION_STATUS.Completed,
        );
        drain(progress, NOW + 1001);
        expect(remaining()).toEqual(
            [20, 80].map((watermark) => ({ revision: 0, watermark })),
        );
    });

    it("keeps an old revision's active claim while rebinding source scopes to the new revision", () => {
        const progress = new SqliteChainProgress();
        sample(progress, 10);
        sample(progress, 20);
        demand("claimed", 0, 0);
        db.prepare(
            "UPDATE order_validation_demand SET claim_admission_sequence=1,claim_chain_revision=0,lease_owner='worker',lease_until=? WHERE order_id='claimed'",
        ).run(NOW + 1000);
        pendingMaker(11, 12);
        advanceChainSyncRevision(CHAIN);
        sample(progress, 30);
        sample(progress, 40);
        drain(progress);
        expect(remaining()).toEqual([
            { revision: 0, watermark: 10 },
            { revision: 1, watermark: 30 },
            { revision: 1, watermark: 40 },
        ]);
        drain(progress, NOW + 1001);
        expect(remaining()).toEqual([
            { revision: 1, watermark: 30 },
            { revision: 1, watermark: 40 },
        ]);
    });

    it("continues after a fully pinned page across adapter restart and retains the late-read watermark fence", () => {
        const progress = new SqliteChainProgress();
        const size = MARKET_DATA_STORAGE_POLICY.maintenanceBatchRows;
        db.writeTransaction(() => {
            for (let sequence = 1; sequence <= size + 2; sequence++) {
                sample(progress, sequence);
                if (sequence <= size) demand(`pending-${sequence}`, sequence);
            }
        })();
        expect(progress.pruneHeadSamples({ now: NOW, limit: size })).toEqual({
            examined: size,
            removed: 0,
        });
        expect(
            new SqliteChainProgress().pruneHeadSamples({
                now: NOW,
                limit: size,
            }),
        ).toEqual({ examined: 2, removed: 1 });
        expect(remaining()).toHaveLength(size + 1);
        progress.recordHeadSample(
            {
                checkpoint: { chainId: CHAIN, revision: 0 },
                admissionWatermark: size + 1,
            },
            block(2000),
            NOW + 1,
        );
        expect(remaining()).toHaveLength(size + 1);
        expect(progress.admissionBarrier(CHAIN, size + 2)?.blockNumber).toBe(
            900 + size + 2,
        );
    });
});
