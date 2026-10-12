import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { CanonicalSyncJobAdmission } from "../src/application/canonical-sync-job-admission.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { runWorker } from "../src/application/worker-runner.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { eventSyncFollowUp } from "../src/domain/sync-follow-ups.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    insertCollection,
    selectBalanceOwners,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import {
    FINALIZED_SYNC_CHECK_POLICY,
    syncBlockFixture,
} from "./helpers/chain-fixture.js";
import {
    canonicalRecoveryBlock,
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    REORG_FIXTURE as F,
} from "./helpers/reorg-recovery-fixture.js";

// Deliberately assert the migration-file boundary and its pre-upgrade storage.
const MIGRATION = "073_reconcile_legacy_block_headers.sql";

describe("legacy mixed-fork header cleanup", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        // This data-only migration has no schema changes. Removing its fixture
        // registration reconstructs the schema immediately before upgrade.
        db.prepare("DELETE FROM migrations WHERE name=?").run(MIGRATION);
    });

    function fixture(
        withTransfer = false,
        options: { gapWorkEnabled?: boolean } = {},
    ) {
        const rpc = new RecoveryRpc();
        const services = reorgRecoveryServices(rpc, options);
        const f = withTransfer ? seedRecoveryHistory() : transferFixture();
        const collection = services.registry.getCollection(1, f.collectionId)!;
        const persist = (numbers: number[], canonical = false) =>
            services.storage.persistSyncResult({
                checkpoint: services.storage.captureSyncCheckpoint(1),
                canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                collections: [collection],
                blocks: numbers.map((n) =>
                    canonical ? canonicalRecoveryBlock(n) : syncBlockFixture(n),
                ),
                data: emptyOnChainData(),
            });
        if (!withTransfer) persist([F.Anchor, F.Fork, F.Orphan]);
        persist([F.Orphan + 1], true);
        db.prepare("UPDATE blocks SET created_at=? WHERE chain_id=1").run(
            "2000-01-01 00:00:00",
        );
        return { ...services, ...f, collection, rpc, persist };
    }

    // A small fixture can compare every table except headers/registration, including data with
    // no block reference. This is stronger than checking only deletion counts.
    function retainedRows() {
        const mutable = new Set(["blocks", "migrations"]);
        const tables = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as { name: string }[];
        return Object.fromEntries(
            tables
                .filter(({ name }) => !mutable.has(name))
                .map(({ name }) => [
                    name,
                    db
                        .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
                        .all(),
                ]),
        );
    }

    it("preserves unused identities and all coverage until verified rollback, then reacquires canonical history", async () => {
        const s = fixture();
        const otherCollection = insertCollection({
            chainId: 1,
            slug: "other-scope",
            address: F.Owner,
            anchorBlock: 100,
        });
        db.prepare(
            "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,?)",
        ).run(otherCollection, F.Orphan);
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Prepared,
            otherCollection,
        );
        const otherChainCollection = insertCollection({
            chainId: 2,
            slug: "other-chain",
            address: F.Owner,
            anchorBlock: 100,
        });
        s.storage.persistSyncResult({
            checkpoint: s.storage.captureSyncCheckpoint(2),
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            collections: [s.registry.getCollection(2, otherChainCollection)!],
            blocks: [syncBlockFixture(F.Orphan)],
            data: emptyOnChainData(),
        });
        const before = retainedRows();
        const checkpoint = s.storage.captureSyncCheckpoint(1);
        const otherCheckpoint = s.storage.captureSyncCheckpoint(2);
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(s.storage.captureSyncCheckpoint(1)).toEqual(checkpoint);
        expect(s.storage.captureSyncCheckpoint(2)).toEqual(otherCheckpoint);

        // Only the canonical owner may invalidate history after fresh proof.
        expect(await s.recovery.checkDue()).toBe(true);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBeNull();
        expect(s.storage.captureSyncCheckpoint(1).revision).toBe(
            checkpoint.revision + 1,
        );
        expect(await s.executor.runDue()).toBe(true);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            canonicalRecoveryBlock(F.Orphan).hash,
        );
        expect(s.storage.getBlockHash(2, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(s.storage.captureSyncCheckpoint(2)).toEqual(otherCheckpoint);
        const after = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(after);
    });

    it("retains fact-backed identities and ownership for verification without deleting any facts or coverage", async () => {
        const s = fixture(true);
        const before = retainedRows();
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
            )
            .all();
        const checkpoint = s.storage.captureSyncCheckpoint(1);
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
                )
                .all(),
        ).toEqual(coverage);
        expect(s.storage.captureSyncCheckpoint(1)).toEqual(checkpoint);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(
            s.checks.nextDue({
                chainId: 1,
                now: Date.now(),
                upperBound: F.Head,
            }),
        ).toMatchObject({ blockNumber: F.Orphan });
        expect(
            db
                .prepare(
                    "SELECT canonical_check_pending FROM blocks WHERE chain_id=1 AND block_number=?",
                )
                .get(F.Orphan + 1),
        ).toEqual({ canonical_check_pending: 1 });
    });

    it.each([false, true])(
        "preserves retained event work (legacy JSON identity=%s)",
        async (legacy) => {
            const s = fixture();
            s.outbox.enqueueSyncFollowUp({
                revision: s.storage.captureSyncCheckpoint(1).revision,
                followUp: eventSyncFollowUp(
                    {
                        jobId: "header-dependent-event",
                        kind: DOMAIN_JOB_KIND.MetadataRefresh,
                        queue: QUEUE_NAMES.MetadataRefresh,
                        chainId: 1,
                        collectionId: s.collectionId,
                        payload: {},
                        scheduledAt: 0,
                        attempt: 0,
                    },
                    {
                        blockNumber: F.Orphan,
                        blockHash: syncBlockFixture(F.Orphan).hash,
                    },
                ),
            });
            if (legacy)
                db.exec(
                    "UPDATE queue_outbox SET sync_block_number=NULL,sync_block_hash=NULL",
                );
            const before = retainedRows();
            await createMigrationRunner().runMigrations();
            expect(retainedRows()).toEqual(before);
            expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
                syncBlockFixture(F.Orphan).hash,
            );
        },
    );

    it("preserves a bootstrap anchor even when it has no transfer facts", async () => {
        const s = fixture();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(F.Orphan, s.collectionId);
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
    });

    it("keeps history before collection anchors outside automatic cleanup", async () => {
        const s = fixture();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(F.Orphan + 1, s.collectionId);
        const headers = db
            .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
            .all();
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
            )
            .all();
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(
            db
                .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
                .all(),
        ).toEqual(headers);
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
                )
                .all(),
        ).toEqual(coverage);
    });

    it("preserves ownership checkpoints without requiring retained transfer history", async () => {
        const s = fixture();
        db.prepare(
            "INSERT INTO erc721_ownership_checkpoints(chain_id,collection_id,contract_address,token_id,owner,block_number,block_hash,block_timestamp,bootstrap_anchor_block) VALUES(1,?,?,?,?,?,?,?,?)",
        ).run(
            s.collectionId,
            s.collection.address,
            "1",
            F.Owner,
            F.Orphan,
            syncBlockFixture(F.Orphan).hash,
            F.Orphan,
            F.Anchor,
        );
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
    });

    it("preserves sparse ancestor history and the journal of an active legacy recovery", async () => {
        const s = fixture();
        db.prepare(
            "INSERT INTO chain_reorg_recoveries(chain_id,recovery_id,version,revision,checked_block,stored_hash,observed_hash,phase,retry_at) VALUES(1,?,0,0,?,?,?, ?,?)",
        ).run(
            "legacy-recovery",
            F.Orphan,
            syncBlockFixture(F.Orphan).hash,
            canonicalRecoveryBlock(F.Orphan).hash,
            REORG_RECOVERY_PHASE.AwaitingAncestor,
            Date.now() + 100_000,
        );
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
    });

    function seedCanonicalParent() {
        const update = db.prepare(
            "UPDATE blocks SET block_hash=?,parent_hash=? WHERE chain_id=1 AND block_number=?",
        );
        for (const header of [
            canonicalRecoveryBlock(F.Orphan),
            syncBlockFixture(F.Orphan + 1),
        ])
            update.run(header.hash, header.parentHash, header.number);
    }

    it.each([
        [false, false],
        [true, false],
        [false, true],
        [true, true],
    ])(
        "verifies a bad child independently while preserving pending backoff (parent=%s child=%s)",
        async (parentPending, childPending) => {
            const s = fixture();
            seedCanonicalParent();
            const parentDeadline = Date.now() + 100_000;
            const childDeadline = parentDeadline + 5_000;
            const pending = db.prepare(
                "UPDATE blocks SET canonical_check_pending=?,canonical_check_retry_at=? WHERE chain_id=1 AND block_number=?",
            );
            pending.run(
                Number(parentPending),
                parentPending ? parentDeadline : 0,
                F.Orphan,
            );
            pending.run(
                Number(childPending),
                childPending ? childDeadline : 0,
                F.Orphan + 1,
            );
            const before = retainedRows();
            await createMigrationRunner().runMigrations();
            expect(retainedRows()).toEqual(before);
            const status = db.prepare(
                "SELECT canonical_check_pending,canonical_check_retry_at FROM blocks WHERE chain_id=1 AND block_number=?",
            );
            expect(status.get(F.Orphan)).toEqual({
                canonical_check_pending: 1,
                canonical_check_retry_at: parentPending ? parentDeadline : 0,
            });
            expect(status.get(F.Orphan + 1)).toEqual({
                canonical_check_pending: 1,
                canonical_check_retry_at: childPending ? childDeadline : 0,
            });
            const parent = s.checks.nextDue({
                chainId: 1,
                now: childDeadline + 1,
                upperBound: F.Orphan,
            })!;
            await s.recovery.checkBlock(parent);
            expect(s.recoveries.getRecovery(1)).toBeNull();
            expect(status.get(F.Orphan + 1)).toEqual({
                canonical_check_pending: 1,
                canonical_check_retry_at: childPending ? childDeadline : 0,
            });
            const child = s.checks.nextDue({
                chainId: 1,
                now: childDeadline + 1,
                upperBound: F.Head,
            })!;
            await s.recovery.checkBlock(child);
            // The child's old parent identity still proves older divergence:
            // a matching repair island must not hide missing orphan history.
            expect(s.storage.getBlockHash(1, F.Orphan)).toBeNull();
            expect(s.storage.getBlockHash(1, F.Orphan + 1)).toBeNull();
            expect(s.recoveries.getRecovery(1)?.phase).toBe(
                REORG_RECOVERY_PHASE.Resync,
            );
            expect(await s.executor.runDue()).toBe(true);
            expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
                canonicalRecoveryBlock(F.Orphan).hash,
            );
        },
    );

    it.each([false, true])(
        "preserves a bad parent's deadline while independently verifying its good child (child pending=%s)",
        async (childPending) => {
            const s = fixture();
            const deadline = Date.now() + 100_000;
            db.prepare(
                "UPDATE blocks SET canonical_check_pending=1,canonical_check_retry_at=? WHERE chain_id=1 AND block_number=?",
            ).run(deadline, F.Orphan);
            db.prepare(
                "UPDATE blocks SET canonical_check_pending=?,canonical_check_retry_at=? WHERE chain_id=1 AND block_number=?",
            ).run(
                Number(childPending),
                childPending ? deadline - 1 : 0,
                F.Orphan + 1,
            );
            await createMigrationRunner().runMigrations();
            expect(
                db
                    .prepare(
                        "SELECT canonical_check_retry_at FROM blocks WHERE chain_id=1 AND block_number=?",
                    )
                    .get(F.Orphan),
            ).toEqual({ canonical_check_retry_at: deadline });
            const child = s.checks.nextDue({
                chainId: 1,
                now: deadline + 1,
                upperBound: F.Head,
            })!;
            expect(child.blockNumber).toBe(F.Orphan + 1);
            await s.recovery.checkBlock(child);
            expect(s.recoveries.getRecovery(1)).toBeNull();
            expect(
                s.checks.nextDue({
                    chainId: 1,
                    now: deadline + 1,
                    upperBound: F.Head,
                })?.blockNumber,
            ).toBe(F.Orphan);
            expect(
                db
                    .prepare(
                        "SELECT canonical_check_retry_at FROM blocks WHERE chain_id=1 AND block_number=?",
                    )
                    .get(F.Orphan),
            ).toEqual({ canonical_check_retry_at: deadline });
        },
    );

    it("recovers an explicitly checked child-only fork above a canonical bootstrap anchor", async () => {
        const s = fixture();
        // Both legacy identities are mature enough for the public poller.
        vi.spyOn(s.rpc, "getBlockNumber").mockResolvedValue(F.Head + 3);
        seedCanonicalParent();
        // This fork shares the canonical anchor; it has no broken parent link.
        // Its explicit checks model the acquisition conflict handoff.
        db.prepare(
            "UPDATE blocks SET parent_hash=? WHERE chain_id=1 AND block_number=?",
        ).run(canonicalRecoveryBlock(F.Orphan).hash, F.Orphan + 1);
        for (const blockNumber of [F.Orphan, F.Orphan + 1])
            expect(
                s.checks.retain({
                    chainId: F.ChainId,
                    blockNumber,
                    blockHash: s.storage.getBlockHash(F.ChainId, blockNumber)!,
                    checkpoint: s.storage.captureSyncCheckpoint(F.ChainId),
                }),
            ).toBe(true);
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(F.Orphan, s.collectionId);
        const bootstrap = new SqliteBootstrapStorage();
        bootstrap.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId: s.collectionId,
                contract: s.contract,
                tokenId: "1",
                owner: F.OrphanOwner,
                anchorBlock: F.Orphan,
            },
        ]);
        bootstrap.finalizeSnapshot({
            runId: 1,
            chainId: 1,
            collectionId: s.collectionId,
            contract: s.contract,
            anchorBlock: F.Orphan,
            anchorHash: canonicalRecoveryBlock(F.Orphan).hash,
            anchorTimestamp: F.Orphan,
        });
        await createMigrationRunner().runMigrations();
        expect(await s.recovery.checkDue()).toBe(true); // Matching anchor.
        expect(await s.recovery.checkDue()).toBe(true); // Orphaned child.
        expect(s.recoveries.getRecovery(1)).toMatchObject({
            phase: REORG_RECOVERY_PHASE.Resync,
            fromBlock: F.Orphan + 1,
        });
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            canonicalRecoveryBlock(F.Orphan).hash,
        );
        expect(await s.executor.runDue()).toBe(true);
        expect(selectBalanceOwners(1, s.collectionId, "1")).toEqual([
            { owner: F.OrphanOwner, amount: "1" },
        ]);
    });

    it.each([COLLECTION_STATUS.Live, COLLECTION_STATUS.Prepared])(
        "executes published canonical event work after upgrade before acquisition (collection=%s)",
        async (status) => {
            const s = fixture(false, { gapWorkEnabled: false });
            seedCanonicalParent();
            db.prepare(
                "UPDATE collections SET status=? WHERE collection_id=?",
            ).run(status, s.collectionId);
            const published: JobEnvelope<unknown>[] = [];
            let receive:
                | ((message: QueueMessage<unknown>) => Promise<void>)
                | undefined;
            const queue: QueuePort = {
                async publish(_queue, job) {
                    published.push(job);
                },
                async subscribe(_queue, handler) {
                    receive = handler as (
                        message: QueueMessage<unknown>,
                    ) => Promise<void>;
                    return async () => {};
                },
                async close() {},
            };
            s.outbox.enqueueSyncFollowUp({
                revision: s.storage.captureSyncCheckpoint(1).revision,
                followUp: eventSyncFollowUp(
                    {
                        jobId: "published-header-event",
                        kind: DOMAIN_JOB_KIND.MetadataRefresh,
                        queue: QUEUE_NAMES.MetadataRefresh,
                        chainId: 1,
                        collectionId: s.collectionId,
                        payload: {},
                        scheduledAt: 0,
                        attempt: 0,
                    },
                    {
                        blockNumber: F.Orphan,
                        blockHash: canonicalRecoveryBlock(F.Orphan).hash,
                    },
                ),
            });
            await drainQueueOutbox(s.outbox, queue);
            expect(published).toHaveLength(1);
            expect(
                db.prepare("SELECT COUNT(*) count FROM queue_outbox").get(),
            ).toEqual({ count: 0 });
            const before = retainedRows();
            await createMigrationRunner().runMigrations();
            expect(retainedRows()).toEqual(before);
            const handler = vi.fn(async () => {});
            const stop = await runWorker(
                queue,
                {
                    queue: QUEUE_NAMES.MetadataRefresh,
                    consumerName: "legacy-header-event-test",
                },
                handler,
                { admission: new CanonicalSyncJobAdmission(s.storage) },
            );
            const ack = vi.fn(async () => {}),
                nack = vi.fn(async () => {});
            try {
                expect(receive).toBeDefined();
                await receive!({
                    data: published[0],
                    ack,
                    nack,
                    touch: async () => {},
                });
            } finally {
                await stop();
            }
            expect(handler).toHaveBeenCalledWith(published[0], undefined);
            expect(ack).toHaveBeenCalledOnce();
            expect(nack).not.toHaveBeenCalled();
            expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
                canonicalRecoveryBlock(F.Orphan).hash,
            );
        },
    );

    it("leaves post-upgrade header identities outside legacy discovery", async () => {
        fixture();
        db.prepare(
            "UPDATE blocks SET created_at=? WHERE chain_id=1 AND block_number=?",
        ).run("2999-01-01 00:00:00", F.Orphan);
        const before = db
            .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
            .all();
        await createMigrationRunner().runMigrations();
        expect(
            db
                .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
                .all(),
        ).toEqual(before);
    });

    it("rolls back verification flags and migration registration together on failure", async () => {
        const s = fixture();
        const headers = db
            .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
            .all();
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
            )
            .all();
        const checkpoint = s.storage.captureSyncCheckpoint(1);
        const before = retainedRows();
        db.exec(
            "CREATE TEMP TRIGGER fail_header_cleanup BEFORE UPDATE ON blocks WHEN NEW.canonical_check_pending=1 BEGIN SELECT RAISE(ABORT,'header cleanup unavailable'); END;",
        );
        await expect(createMigrationRunner().runMigrations()).rejects.toThrow(
            "header cleanup unavailable",
        );
        expect(retainedRows()).toEqual(before);
        expect(
            db
                .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
                .all(),
        ).toEqual(headers);
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
                )
                .all(),
        ).toEqual(coverage);
        expect(s.storage.captureSyncCheckpoint(1)).toEqual(checkpoint);
        expect(
            db
                .prepare("SELECT name FROM migrations WHERE name=?")
                .get(MIGRATION),
        ).toBeUndefined();
        db.exec("DROP TRIGGER fail_header_cleanup;");
        await createMigrationRunner().runMigrations();
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(s.checks.hasPending(1, Date.now())).toBe(true);
    });
});
