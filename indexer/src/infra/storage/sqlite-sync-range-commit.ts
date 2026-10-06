import { db } from "@artgod/shared/database";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import {
    assertSyncBlocksCoverRange,
    assertSyncFollowUpsMatchBlocks,
} from "../../domain/sync-result.js";
import {
    isCurrentSyncGapRepair,
    remainingSyncGapRepairRange,
} from "../../domain/sync-gap-repair.js";
import { isCurrentReorgRange } from "../../domain/reorg-recovery.js";
import { SYNC_WORK_COMPLETION } from "../../domain/sync-work.js";
import type {
    SyncRangeCommit,
    SyncRangeCommitPort,
} from "../../ports/sync-range-commit.js";
import type { StoragePort } from "../../ports/storage.js";
import type { SqliteQueueOutbox } from "../queue/sqlite-queue-outbox.js";
import type { SyncGapStorePort } from "../../application/sync-gap-scheduler.js";
import type { ReorgRecoveryStore } from "../../application/reorg-recovery.js";
import type { CollectionRegistryPort } from "../../ports/collections.js";

// Composition injects adapters for the same SQLite database. One writer validates
// ownership and commits facts, required follow-ups and acquisition progress.
// RPC and broker publication remain outside the transaction.
export class SqliteSyncRangeCommit implements SyncRangeCommitPort {
    constructor(
        private readonly ports: {
            storage: StoragePort;
            outbox: Pick<SqliteQueueOutbox, "enqueueSyncFollowUp">;
            gaps: Pick<
                SyncGapStorePort,
                "getProgress" | "recordRepairProgress"
            >;
            recoveries: Pick<
                ReorgRecoveryStore,
                "getRecovery" | "completeResyncRange"
            >;
            collections: Pick<CollectionRegistryPort, "getCollection">;
        },
    ) {}

    commitSyncRange(input: SyncRangeCommit): void {
        const { result, followUps, completion } = input;
        const chainId = result.checkpoint.chainId;
        db.writeTransaction(() => {
            this.assertCurrent(input);
            assertSyncFollowUpsMatchBlocks({
                chainId,
                blocks: result.blocks,
                collectionIds: result.collections.map(
                    (collection) => collection.id,
                ),
                followUps,
            });
            this.ports.storage.persistSyncResult(result);
            for (const followUp of followUps)
                this.ports.outbox.enqueueSyncFollowUp({
                    followUp,
                    revision: result.checkpoint.revision,
                });
            if (completion.kind === SYNC_WORK_COMPLETION.GapRepair) {
                for (const repair of completion.batch.repairs)
                    if (
                        !this.ports.gaps.recordRepairProgress({
                            chainId,
                            repair,
                            remaining: remainingSyncGapRepairRange(
                                repair,
                                completion.batch.fromBlock,
                            ),
                            retryAt: completion.retryAt,
                        })
                    )
                        throw new ChainSyncConflict(
                            "Gap repair completion changed inside sync commit",
                        );
            } else if (completion.kind === SYNC_WORK_COMPLETION.ReorgResync) {
                if (
                    !this.ports.recoveries.completeResyncRange({
                        range: completion.range,
                        batchSize: completion.batchSize,
                        retryAt: completion.retryAt,
                    })
                )
                    throw new ChainSyncConflict(
                        "Reorg range completion changed inside sync commit",
                    );
            }
        })();
    }

    private assertCurrent({ result, completion }: SyncRangeCommit): void {
        const chainId = result.checkpoint.chainId;
        if (completion.kind === SYNC_WORK_COMPLETION.Unmanaged) return;
        const range =
            completion.kind === SYNC_WORK_COMPLETION.GapRepair
                ? completion.batch
                : completion.range;
        assertSyncBlocksCoverRange({ blocks: result.blocks, ...range });
        if (completion.kind === SYNC_WORK_COMPLETION.ReorgResync) {
            if (
                completion.range.chainId !== chainId ||
                completion.range.revision !== result.checkpoint.revision ||
                !isCurrentReorgRange(
                    this.ports.recoveries.getRecovery(chainId),
                    completion.range,
                )
            )
                throw new ChainSyncConflict(
                    "Reorg acquisition no longer owns its range",
                );
            return;
        }
        const acquired = new Set(
            result.collections.map((collection) => collection.id),
        );
        if (
            !completion.batch.repairs.length ||
            acquired.size !== completion.batch.repairs.length
        )
            throw new ChainSyncConflict(
                "Gap acquisition has different members",
            );
        for (const repair of completion.batch.repairs) {
            if (
                !acquired.has(repair.collectionId) ||
                completion.batch.fromBlock < repair.fromBlock ||
                completion.batch.toBlock !== repair.toBlock ||
                !isCurrentSyncGapRepair({
                    chainId,
                    repair,
                    collection: this.ports.collections.getCollection(
                        chainId,
                        repair.collectionId,
                    ),
                    progress: this.ports.gaps.getProgress(
                        chainId,
                        repair.collectionId,
                    ),
                })
            )
                throw new ChainSyncConflict(
                    "Gap acquisition no longer owns its member range",
                );
            acquired.delete(repair.collectionId);
        }
    }
}
