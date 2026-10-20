import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    ChainSyncConflict,
    StoredBlockHashConflict,
    type AppliedChainProgress,
    type ChainBlockReference,
    type ChainSyncCheckpoint,
    type CollectionAppliedProgress,
    type SyncBlockHeader,
    type ValidationCheckpoint,
} from "../../domain/chain-sync.js";
import type { PendingCanonicalCheck } from "../../domain/canonical-check.js";
import { REORG_RECOVERY_PHASE } from "../../domain/reorg-recovery.js";
import {
    assertAppliedSyncRange,
    assertSyncBlockHeaders,
} from "../../domain/sync-result.js";
import type {
    ChainHeadSample,
    ChainHeadSampleRequest,
    ChainProgressPort,
} from "../../ports/chain-progress.js";
import {
    assertChainSyncCheckpoint,
    captureChainSyncCheckpoint,
} from "./sqlite-chain-revisions.js";
import { persistCanonicalBlocks } from "./sqlite-canonical-headers.js";
import { SqliteCanonicalChecks } from "./sqlite-canonical-checks.js";
import { MAKER_REVALIDATION_STATUS } from "../../domain/maker-revalidation.js";

type ProgressRow = {
    chain_id: number;
    revision: number;
    anchor_block: number;
    anchor_hash: string;
    applied_block: number;
    applied_hash: string;
};

/** Durable applied evidence. Only coordinator transitions write these cursors;
 * neither validation nor mere acquisition coverage can create readiness. */
export class SqliteChainProgress implements ChainProgressPort {
    chainProgress(chainId: number): AppliedChainProgress | null {
        const row = db
            .prepare("SELECT * FROM chain_sync_progress WHERE chain_id=?")
            .get(chainId) as ProgressRow | undefined;
        return row ? this.progress(row) : null;
    }

    collectionProgress(
        chainId: number,
        collectionId: number,
    ): CollectionAppliedProgress | null {
        const row = db
            .prepare(
                "SELECT * FROM collection_sync_progress WHERE chain_id=? AND collection_id=?",
            )
            .get(chainId, collectionId) as ProgressRow | undefined;
        return row ? { ...this.progress(row), collectionId } : null;
    }

    initializeChain(
        checkpoint: ChainSyncCheckpoint,
        anchor: SyncBlockHeader,
    ): void {
        db.writeTransaction(() => {
            assertChainSyncCheckpoint(checkpoint);
            assertSyncBlockHeaders([anchor]);
            const current = this.chainProgress(checkpoint.chainId);
            if (current) {
                if (
                    current.anchor.number !== anchor.number ||
                    current.anchor.hash !== anchor.hash
                )
                    throw new ChainSyncConflict(
                        "Chain already has a different initialization anchor",
                    );
                return;
            }
            if (this.recoveryRetained(checkpoint.chainId))
                throw new ChainSyncConflict(
                    "Chain initialization is blocked by recovery",
                );
            // Explicit base acceptance is the sole exception to forward adjacency.
            // Existing isolated headers are never promoted to applied coverage.
            persistCanonicalBlocks(checkpoint, [anchor], () => true);
            db.prepare(
                "INSERT INTO chain_sync_progress(chain_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?)",
            ).run(
                checkpoint.chainId,
                checkpoint.revision,
                anchor.number,
                anchor.hash,
                anchor.number,
                anchor.hash,
            );
            // Samples from before initialization can name history deliberately
            // outside this base. Leave those admissions unbound for a later
            // healthy sample instead of requiring nonexistent local ancestry.
            db.prepare(
                "DELETE FROM chain_head_samples WHERE chain_id=? AND revision=? AND block_number<?",
            ).run(checkpoint.chainId, checkpoint.revision, anchor.number);
            db.prepare(
                "DELETE FROM chain_sync_targets WHERE chain_id=? AND revision=? AND block_number<?",
            ).run(checkpoint.chainId, checkpoint.revision, anchor.number);
            const conflictingAnchorSample = db
                .prepare(
                    "SELECT 1 FROM chain_head_samples WHERE chain_id=? AND revision=? AND block_number=? AND block_hash<>? LIMIT 1",
                )
                .get(
                    checkpoint.chainId,
                    checkpoint.revision,
                    anchor.number,
                    anchor.hash,
                );
            if (conflictingAnchorSample)
                this.retainDispute({
                    chainId: checkpoint.chainId,
                    checkpoint,
                    blockNumber: anchor.number,
                    blockHash: anchor.hash,
                });
        })();
    }

    acceptCollectionBase(
        checkpoint: ChainSyncCheckpoint,
        collectionId: number,
        anchor: SyncBlockHeader,
    ): void {
        db.writeTransaction(() => {
            this.assertAvailable(checkpoint, true);
            const chain = this.requireChain(checkpoint.chainId);
            assertSyncBlockHeaders([anchor]);
            if (anchor.number > chain.applied.number)
                throw new ChainSyncConflict(
                    "Collection base is outside applied chain history",
                );
            const installed = db
                .prepare(
                    "SELECT 1 FROM collection_ownership_bases b JOIN collections c ON c.collection_id=b.collection_id AND c.chain_id=b.chain_id " +
                        "WHERE b.chain_id=? AND b.collection_id=? AND b.revision=? AND b.anchor_block=? AND b.anchor_hash=? AND c.bootstrap_anchor_block=b.anchor_block",
                )
                .get(
                    checkpoint.chainId,
                    collectionId,
                    checkpoint.revision,
                    anchor.number,
                    anchor.hash,
                );
            if (!installed)
                throw new ChainSyncConflict(
                    "Collection ownership base has not been installed at this identity",
                );
            // A slow bootstrap may install an older base after shared startup.
            // Its own replay must join the shared base before granting proof
            // readiness; this never lowers the shared anchor or its effects.
            if (anchor.number >= chain.anchor.number)
                this.assertMember(checkpoint.chainId, anchor);
            else persistCanonicalBlocks(checkpoint, [anchor], () => false);
            const current = this.collectionProgress(
                checkpoint.chainId,
                collectionId,
            );
            if (current) {
                if (
                    current.anchor.number !== anchor.number ||
                    current.anchor.hash !== anchor.hash ||
                    current.checkpoint.revision !== checkpoint.revision
                )
                    throw new ChainSyncConflict(
                        "Collection already has a different applied base",
                    );
                return;
            }
            db.prepare(
                "INSERT INTO collection_sync_progress(chain_id,collection_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?,?)",
            ).run(
                checkpoint.chainId,
                collectionId,
                checkpoint.revision,
                anchor.number,
                anchor.hash,
                anchor.number,
                anchor.hash,
            );
        })();
    }

    captureHeadSample(chainId: number): ChainHeadSampleRequest {
        return db.raw.transaction(() => {
            const row = db
                .prepare(
                    "SELECT admission_sequence FROM chain_sync_revisions WHERE chain_id=?",
                )
                .get(chainId) as { admission_sequence: number } | undefined;
            return {
                checkpoint: captureChainSyncCheckpoint(chainId),
                admissionWatermark: row?.admission_sequence ?? 0,
            };
        })();
    }

    recordHeadSample(
        request: ChainHeadSampleRequest,
        head: SyncBlockHeader,
        now: number,
    ): void {
        db.writeTransaction(() => {
            assertChainSyncCheckpoint(request.checkpoint);
            assertSyncBlockHeaders([head]);
            const { chainId, revision } = request.checkpoint;
            const chain = this.chainProgress(chainId);
            if (chain && head.number < chain.anchor.number)
                throw new ChainSyncConflict(
                    "Head sample predates the accepted chain base",
                );
            if (chain && head.number <= chain.applied.number) {
                const accepted = this.header(chainId, head.number);
                if (!accepted)
                    throw new ChainSyncConflict(
                        "Head sample has lost applied lineage",
                    );
                if (accepted.hash !== head.hash)
                    this.retainDispute({
                        chainId,
                        checkpoint: request.checkpoint,
                        blockNumber: head.number,
                        blockHash: accepted.hash,
                    });
            }
            // Overlapping pre-restart work must not remap admissions already
            // covered by an earlier successful sample with a larger watermark.
            if (
                db
                    .prepare(
                        "SELECT 1 FROM chain_head_samples WHERE chain_id=? AND revision=? AND admission_watermark>? LIMIT 1",
                    )
                    .get(chainId, revision, request.admissionWatermark)
            )
                return;
            // Freeze the first successful sample for this watermark. Later HEAD
            // movement cannot move an admitted generation's finishing line.
            db.prepare(
                "INSERT INTO chain_head_samples(chain_id,revision,admission_watermark,block_number,block_hash,sampled_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            ).run(
                chainId,
                revision,
                request.admissionWatermark,
                head.number,
                head.hash,
                now,
            );
            db.prepare(
                "INSERT INTO chain_sync_targets(chain_id,revision,block_number,block_hash,sampled_at) VALUES (?,?,?,?,?) ON CONFLICT(chain_id) DO UPDATE SET revision=excluded.revision,block_number=excluded.block_number,block_hash=excluded.block_hash,sampled_at=excluded.sampled_at WHERE excluded.sampled_at>=chain_sync_targets.sampled_at",
            ).run(chainId, revision, head.number, head.hash, now);
        })();
    }

    headTarget(chainId: number): ChainHeadSample | null {
        return (
            (db
                .prepare(
                    "SELECT chain_id AS chainId,revision,block_number AS blockNumber,block_hash AS blockHash,sampled_at AS sampledAt FROM chain_sync_targets WHERE chain_id=? AND revision=?",
                )
                .get(chainId, captureChainSyncCheckpoint(chainId).revision) as
                | ChainHeadSample
                | undefined) ?? null
        );
    }

    admissionBarrier(
        chainId: number,
        admissionSequence: number,
    ): ChainHeadSample | null {
        return (
            (db
                .prepare(
                    "SELECT chain_id AS chainId,revision,block_number AS blockNumber,block_hash AS blockHash,sampled_at AS sampledAt FROM chain_head_samples WHERE chain_id=? AND revision=? AND admission_watermark>=? ORDER BY admission_watermark LIMIT 1",
                )
                .get(
                    chainId,
                    captureChainSyncCheckpoint(chainId).revision,
                    admissionSequence,
                ) as ChainHeadSample | undefined) ?? null
        );
    }

    pruneHeadSamples({ now, limit }: { now: number; limit: number }): {
        examined: number;
        removed: number;
    } {
        if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            !Number.isSafeInteger(now)
        )
            throw new Error("Invalid head sample retention batch");
        const cursor = db
            .prepare(
                "SELECT after_chain_id AS chainId,after_revision AS revision,after_admission_watermark AS watermark FROM chain_head_sample_cleanup WHERE singleton=1",
            )
            .get() as
            | { chainId: number; revision: number; watermark: number }
            | undefined;
        const rows = db
            .prepare(
                "SELECT chain_id AS chainId,revision,admission_watermark AS watermark FROM chain_head_samples WHERE (chain_id,revision,admission_watermark)>(?,?,?) ORDER BY chain_id,revision,admission_watermark LIMIT ?",
            )
            .all(
                cursor?.chainId ?? -1,
                cursor?.revision ?? -1,
                cursor?.watermark ?? -1,
                limit,
            ) as {
            chainId: number;
            revision: number;
            watermark: number;
        }[];
        if (!rows.length) {
            if (cursor)
                db.writeTransaction(() =>
                    db
                        .prepare(
                            "DELETE FROM chain_head_sample_cleanup WHERE singleton=1",
                        )
                        .run(),
                )();
            return { examined: 0, removed: 0 };
        }

        const previous = db.prepare(
            "SELECT COALESCE(MAX(admission_watermark),0) AS watermark FROM chain_head_samples WHERE chain_id=? AND revision=? AND admission_watermark<?",
        );
        const latest = db.prepare(
            "SELECT MAX(admission_watermark) AS watermark FROM chain_head_samples WHERE chain_id=? AND revision=?",
        );
        const pending = db.prepare(
            "SELECT 1 FROM order_validation_demand WHERE chain_id=? AND pending=1 AND admission_sequence>? AND admission_sequence<=? LIMIT 1",
        );
        const claim = db.prepare(
            "SELECT 1 FROM order_validation_demand WHERE chain_id=? AND claim_chain_revision=? AND claim_admission_sequence>? AND claim_admission_sequence<=? AND lease_owner IS NOT NULL AND lease_until>? LIMIT 1",
        );
        const makerPass = db.prepare(
            "SELECT 1 FROM maker_order_revalidation_runs WHERE chain_id=? AND status=? AND admission_sequence>? AND admission_sequence<=? LIMIT 1",
        );
        const makerFollowup = db.prepare(
            "SELECT 1 FROM maker_order_revalidation_runs WHERE chain_id=? AND status=? AND requested_admission_sequence>? AND requested_admission_sequence<=? LIMIT 1",
        );
        const remove = db.prepare(
            "DELETE FROM chain_head_samples WHERE chain_id=? AND revision=? AND admission_watermark=?",
        );
        return db.writeTransaction(() => {
            let removed = 0;
            for (const row of rows) {
                const currentRevision = captureChainSyncCheckpoint(
                    row.chainId,
                ).revision;
                const current = row.revision === currentRevision;
                // This sample also fences overlapping late head reads. Keep it
                // even when no order currently needs its admission interval.
                if (
                    current &&
                    row.watermark ===
                        (
                            latest.get(row.chainId, row.revision) as {
                                watermark: number;
                            }
                        ).watermark
                )
                    continue;
                const lower = (
                    previous.get(row.chainId, row.revision, row.watermark) as {
                        watermark: number;
                    }
                ).watermark;
                if (
                    claim.get(
                        row.chainId,
                        row.revision,
                        lower,
                        row.watermark,
                        now,
                    ) ||
                    (current &&
                        (pending.get(row.chainId, lower, row.watermark) ||
                            makerPass.get(
                                row.chainId,
                                MAKER_REVALIDATION_STATUS.Pending,
                                lower,
                                row.watermark,
                            ) ||
                            makerFollowup.get(
                                row.chainId,
                                MAKER_REVALIDATION_STATUS.Pending,
                                lower,
                                row.watermark,
                            )))
                )
                    continue;
                // Pin checks and deletion share the writer: new admission or a
                // lease renewal cannot lose its mapping between these actions.
                removed += remove.run(
                    row.chainId,
                    row.revision,
                    row.watermark,
                ).changes;
            }
            const last = rows[rows.length - 1];
            db.prepare(
                "INSERT INTO chain_head_sample_cleanup(singleton,after_chain_id,after_revision,after_admission_watermark) VALUES (1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET after_chain_id=excluded.after_chain_id,after_revision=excluded.after_revision,after_admission_watermark=excluded.after_admission_watermark",
            ).run(last.chainId, last.revision, last.watermark);
            return { examined: rows.length, removed };
        })();
    }

    validationCheckpoint(
        chainId: number,
        collectionId: number,
        barrier?: ChainBlockReference | null,
    ): ValidationCheckpoint | null {
        return db.raw.transaction(() => {
            const checkpoint = captureChainSyncCheckpoint(chainId);
            if (this.isUnavailable(chainId)) return null;
            const chain = this.chainProgress(chainId);
            const scope = this.collectionProgress(chainId, collectionId);
            if (
                !chain ||
                !scope ||
                chain.checkpoint.revision !== checkpoint.revision ||
                scope.checkpoint.revision !== checkpoint.revision ||
                !this.currentCollectionBase(
                    chainId,
                    collectionId,
                    scope.anchor.number,
                )
            )
                return null;
            const number = Math.min(chain.applied.number, scope.applied.number);
            if (number < Math.max(scope.anchor.number, chain.anchor.number))
                return null;
            if (
                barrier &&
                (barrier.chainId !== chainId ||
                    barrier.blockNumber > number ||
                    this.header(chainId, barrier.blockNumber)?.hash !==
                        barrier.blockHash)
            )
                return null;
            const block = this.header(chainId, number);
            return block ? { ...checkpoint, collectionId, block } : null;
        })();
    }

    assertValidationCheckpoint(checkpoint: ValidationCheckpoint): void {
        this.assertAvailable(checkpoint);
        const usable = this.validationCheckpoint(
            checkpoint.chainId,
            checkpoint.collectionId,
        );
        if (
            !usable ||
            usable.revision !== checkpoint.revision ||
            usable.block.number < checkpoint.block.number
        )
            throw new ChainSyncConflict(
                "Validation is outside applied collection coverage",
            );
        const scope = this.collectionProgress(
            checkpoint.chainId,
            checkpoint.collectionId,
        )!;
        if (
            checkpoint.block.number <
            Math.max(
                scope.anchor.number,
                this.requireChain(checkpoint.chainId).anchor.number,
            )
        )
            throw new ChainSyncConflict(
                "Validation predates the collection base",
            );
        this.assertMember(checkpoint.chainId, checkpoint.block);
    }

    /** Called inside the range writer before facts/effects; expected progress was
     * captured before acquisition. Presence of a later header cannot skip a gap. */
    assertChainRange(
        expected: AppliedChainProgress,
        blocks: readonly SyncBlockHeader[],
    ): void {
        this.assertAvailable(expected.checkpoint, true);
        this.assertSameProgress(
            this.requireChain(expected.checkpoint.chainId),
            expected,
        );
        assertAppliedSyncRange(expected, blocks);
    }

    /** History may enrich older facts, but cannot install a future header before
     * the coordinator reaches it. Waiting history never owns current catch-up. */
    assertHistoricalRange(
        checkpoint: ChainSyncCheckpoint,
        blocks: readonly SyncBlockHeader[],
    ): void {
        this.assertAvailable(checkpoint);
        const chain = this.requireChain(checkpoint.chainId);
        assertSyncBlockHeaders(blocks);
        for (const block of blocks) {
            if (block.number > chain.applied.number)
                throw new ChainSyncConflict(
                    "Historical import awaits applied chain progress",
                );
            if (block.number >= chain.anchor.number)
                this.assertMember(checkpoint.chainId, block);
        }
    }

    /** Collection catch-up can connect an older installed base to shared history.
     * Its own predecessor fence authorizes below-base lineage; every overlapping
     * shared identity must match and readiness waits until those prefixes join. */
    assertCollectionReplayRange(
        checkpoint: ChainSyncCheckpoint,
        blocks: readonly SyncBlockHeader[],
    ): void {
        this.assertAvailable(checkpoint, true);
        const chain = this.requireChain(checkpoint.chainId);
        assertSyncBlockHeaders(blocks);
        for (const block of blocks) {
            if (block.number > chain.applied.number)
                throw new ChainSyncConflict(
                    "Collection replay is outside applied shared history",
                );
            if (block.number >= chain.anchor.number)
                this.assertMember(checkpoint.chainId, block);
        }
    }

    /** Called after core effects and invalidations, in that same transaction. */
    advanceChain(
        expected: AppliedChainProgress,
        blocks: readonly SyncBlockHeader[],
    ): void {
        this.assertWriter();
        this.assertChainRange(expected, blocks);
        for (const block of blocks) {
            this.assertMember(expected.checkpoint.chainId, block);
            // A sampled target was never canonical evidence. If it changed before
            // this prefix was applied, bind its unchanged height to the accepted
            // branch; no proof of the unaccepted identity could have committed.
            db.prepare(
                "UPDATE chain_head_samples SET block_hash=? WHERE chain_id=? AND revision=? AND block_number=? AND block_hash<>?",
            ).run(
                block.hash,
                expected.checkpoint.chainId,
                expected.checkpoint.revision,
                block.number,
                block.hash,
            );
        }
        const tip = blocks[blocks.length - 1]!;
        db.prepare(
            "UPDATE chain_sync_progress SET applied_block=?,applied_hash=? WHERE chain_id=?",
        ).run(tip.number, tip.hash, expected.checkpoint.chainId);
    }

    assertCollectionRange(
        expected: CollectionAppliedProgress,
        blocks: readonly SyncBlockHeader[],
    ): void {
        this.assertAvailable(expected.checkpoint, true);
        const current = this.collectionProgress(
            expected.checkpoint.chainId,
            expected.collectionId,
        );
        if (
            !current ||
            !this.currentCollectionBase(
                expected.checkpoint.chainId,
                expected.collectionId,
                expected.anchor.number,
            )
        )
            throw new ChainSyncConflict("Collection applied ownership changed");
        this.assertSameProgress(current, expected);
        assertAppliedSyncRange(expected, blocks);
    }

    advanceCollection(
        expected: CollectionAppliedProgress,
        blocks: readonly SyncBlockHeader[],
    ): void {
        this.assertWriter();
        this.assertCollectionRange(expected, blocks);
        const chain = this.requireChain(expected.checkpoint.chainId);
        const tip = blocks[blocks.length - 1]!;
        if (tip.number > chain.applied.number)
            throw new ChainSyncConflict(
                "Collection cannot advance beyond shared protocol effects",
            );
        for (const block of blocks)
            this.assertMember(expected.checkpoint.chainId, block);
        db.prepare(
            "UPDATE collection_sync_progress SET applied_block=?,applied_hash=? WHERE chain_id=? AND collection_id=?",
        ).run(
            tip.number,
            tip.hash,
            expected.checkpoint.chainId,
            expected.collectionId,
        );
    }

    retainDispute(check: PendingCanonicalCheck): void {
        db.writeTransaction(() => {
            if (!new SqliteCanonicalChecks().retain(check, { disputed: true }))
                throw new ChainSyncConflict(
                    "Dispute no longer identifies retained chain history",
                );
        })();
    }

    /** Part of the existing atomic rollback transaction, after revision advances.
     * An anchor-crossing rollback has no automatic ownership-base replacement. */
    rewindAfterRollback(chainId: number, ancestor: SyncBlockHeader): void {
        this.assertWriter();
        const checkpoint = captureChainSyncCheckpoint(chainId);
        // Orphan headers may already have been deleted in this writer, so read
        // the retained cursor row without dereferencing its former applied tip.
        const chain = db
            .prepare("SELECT * FROM chain_sync_progress WHERE chain_id=?")
            .get(chainId) as ProgressRow | undefined;
        if (!chain)
            throw new ChainSyncConflict("Rollback has no applied chain base");
        if (
            ancestor.number < chain.anchor_block ||
            db
                .prepare(
                    "SELECT 1 FROM collection_sync_progress WHERE chain_id=? AND anchor_block>? LIMIT 1",
                )
                .get(chainId, ancestor.number)
        )
            throw new ChainSyncConflict(
                "Rollback crosses an installed chain or collection base",
            );
        this.assertMember(chainId, ancestor);
        db.prepare(
            "UPDATE chain_sync_progress SET revision=?,applied_block=MIN(applied_block,?),applied_hash=CASE WHEN applied_block>? THEN ? ELSE applied_hash END,disputed_from=(SELECT MIN(block_number) FROM blocks WHERE chain_id=? AND canonical_check_disputed=1) WHERE chain_id=?",
        ).run(
            checkpoint.revision,
            ancestor.number,
            ancestor.number,
            ancestor.hash,
            chainId,
            chainId,
        );
        db.prepare(
            "UPDATE collection_sync_progress SET revision=?,applied_block=MIN(applied_block,?),applied_hash=CASE WHEN applied_block>? THEN ? ELSE applied_hash END WHERE chain_id=?",
        ).run(
            checkpoint.revision,
            ancestor.number,
            ancestor.number,
            ancestor.hash,
            chainId,
        );
        db.prepare(
            "UPDATE collection_ownership_bases SET revision=? WHERE chain_id=? AND anchor_block<=?",
        ).run(checkpoint.revision, chainId, ancestor.number);
        db.prepare("DELETE FROM chain_sync_targets WHERE chain_id=?").run(
            chainId,
        );
        // Old sample mappings remain attributable but cannot cover this revision.
    }

    private progress(row: ProgressRow): AppliedChainProgress {
        const anchor = this.header(row.chain_id, row.anchor_block);
        const applied = this.header(row.chain_id, row.applied_block);
        if (
            !anchor ||
            anchor.hash !== row.anchor_hash ||
            !applied ||
            applied.hash !== row.applied_hash
        )
            throw new ChainSyncConflict(
                "Applied progress has lost its retained lineage",
            );
        return {
            checkpoint: { chainId: row.chain_id, revision: row.revision },
            anchor,
            applied,
        };
    }

    private requireChain(chainId: number): AppliedChainProgress {
        const progress = this.chainProgress(chainId);
        if (!progress)
            throw new ChainSyncConflict(
                "Chain requires explicit applied-base initialization",
            );
        return progress;
    }

    private header(chainId: number, number: number): SyncBlockHeader | null {
        return (
            (db
                .prepare(
                    "SELECT block_number AS number,block_hash AS hash,parent_hash AS parentHash,timestamp FROM blocks WHERE chain_id=? AND block_number=?",
                )
                .get(chainId, number) as SyncBlockHeader | undefined) ?? null
        );
    }

    private assertMember(chainId: number, block: SyncBlockHeader): void {
        const stored = this.header(chainId, block.number);
        // Replay checks membership before the facts writer. Preserve the same
        // explicit-disagreement contract here so its rejected transaction still
        // asks the recovery owner to gate and freshly verify the stored branch.
        if (stored && stored.hash !== block.hash)
            throw new StoredBlockHashConflict(
                {
                    chainId,
                    checkpoint: captureChainSyncCheckpoint(chainId),
                    blockNumber: block.number,
                    blockHash: stored.hash,
                },
                block.hash,
            );
        if (
            !stored ||
            stored.hash !== block.hash ||
            stored.parentHash !== block.parentHash ||
            stored.timestamp !== block.timestamp
        )
            throw new ChainSyncConflict(
                "Checkpoint is not a retained canonical block identity",
            );
    }

    private assertSameProgress(
        current: AppliedChainProgress,
        expected: AppliedChainProgress,
    ): void {
        if (
            current.checkpoint.revision !== expected.checkpoint.revision ||
            current.anchor.number !== expected.anchor.number ||
            current.anchor.hash !== expected.anchor.hash ||
            current.applied.number !== expected.applied.number ||
            current.applied.hash !== expected.applied.hash
        )
            throw new ChainSyncConflict(
                "Applied predecessor changed during acquisition",
            );
    }

    private currentCollectionBase(
        chainId: number,
        collectionId: number,
        anchor: number,
    ): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM collections WHERE chain_id=? AND collection_id=? AND bootstrap_anchor_block=? AND status IN (?,?)",
            )
            .get(
                chainId,
                collectionId,
                anchor,
                COLLECTION_STATUS.Live,
                COLLECTION_STATUS.Bootstrapping,
            );
    }

    private recoveryRetained(chainId: number, allowResync = false): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM chain_reorg_recoveries WHERE chain_id=?" +
                    (allowResync ? " AND phase<>?" : ""),
            )
            .get(
                ...(allowResync
                    ? [chainId, REORG_RECOVERY_PHASE.Resync]
                    : [chainId]),
            );
    }

    private isUnavailable(chainId: number, allowResync = false): boolean {
        const disputed = db
            .prepare(
                "SELECT 1 FROM chain_sync_progress WHERE chain_id=? AND disputed_from IS NOT NULL",
            )
            .get(chainId);
        return !!disputed || this.recoveryRetained(chainId, allowResync);
    }

    private assertAvailable(
        checkpoint: ChainSyncCheckpoint,
        allowResync = false,
    ): void {
        assertChainSyncCheckpoint(checkpoint);
        if (this.isUnavailable(checkpoint.chainId, allowResync))
            throw new ChainSyncConflict("Chain view is under recovery");
    }

    private assertWriter(): void {
        if (!db.raw.inTransaction)
            throw new ChainSyncConflict(
                "Applied progress must share its effects transaction",
            );
    }
}
