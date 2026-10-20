import { db } from "@artgod/shared/database";
import type { CollectionRecord } from "../../src/domain/collections.js";
import type { SyncBlockHeader } from "../../src/domain/chain-sync.js";
import type { OnChainData } from "../../src/domain/onchain.js";
import {
    SYNC_APPLICATION_KIND,
    SYNC_WORK_COMPLETION,
    type SyncWorkCompletion,
} from "../../src/domain/sync-work.js";
import type { SyncFollowUp } from "../../src/domain/sync-follow-ups.js";
import type { CanonicalOrderEffectsPort } from "../../src/ports/canonical-order-effects.js";
import type { SyncRangeResult } from "../../src/ports/storage.js";
import { SqliteChainProgress } from "../../src/infra/storage/sqlite-chain-progress.js";
import { SqliteStorage } from "../../src/infra/storage/sqlite.js";
import { SqliteSyncRangeCommit } from "../../src/infra/storage/sqlite-sync-range-commit.js";
import { SqliteSyncGapStore } from "../../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteCanonicalChecks } from "../../src/infra/storage/sqlite-canonical-checks.js";
import { SqliteReorgRecoveries } from "../../src/infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteCollectionRegistry } from "../../src/infra/collections/sqlite.js";
import { FINALIZED_SYNC_CHECK_POLICY } from "./chain-fixture.js";
import { emptyOnChainData } from "./ownership-fixture.js";

/** Real applied-progress and atomic writer adapters for ownership/storage tests.
 * Collections and their known anchored balances are caller-owned fixtures. The
 * installed-base record represents an already verified bootstrap snapshot; its
 * lease/task/snapshot proof is covered by bootstrap installer tests separately.
 * This helper never promotes existing sparse headers into applied coverage. */
export function createAppliedSyncFixture(input: {
    chainId: number;
    anchor: SyncBlockHeader;
    collections: readonly CollectionRecord[];
    orderEffects?: CanonicalOrderEffectsPort;
    now?: () => number;
}) {
    const { chainId, anchor } = input;
    const storage = new SqliteStorage();
    const progress = new SqliteChainProgress();
    const registry = new SqliteCollectionRegistry();
    const outbox = new SqliteQueueOutbox();
    const checkpoint = storage.captureSyncCheckpoint(chainId);
    progress.initializeChain(checkpoint, anchor);
    for (const collection of input.collections) {
        if (
            collection.chainId !== chainId ||
            collection.bootstrapAnchorBlock !== anchor.number
        )
            throw new Error(
                "Applied fixture collection must use the explicit chain anchor",
            );
        db.writeTransaction(() => {
            db.prepare(
                "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,?,?,?,?) ON CONFLICT(chain_id,collection_id) DO NOTHING",
            ).run(
                chainId,
                collection.id,
                collection.id,
                checkpoint.revision,
                anchor.number,
                anchor.hash,
            );
            progress.acceptCollectionBase(checkpoint, collection.id, anchor);
        })();
    }
    const writer = new SqliteSyncRangeCommit({
        storage,
        progress,
        outbox,
        collections: registry,
        gaps: new SqliteSyncGapStore(),
        recoveries: new SqliteReorgRecoveries(
            storage,
            new SqliteCanonicalChecks(),
        ),
        orderEffects: input.orderEffects ?? {
            retain({ effects }) {
                if (effects.length)
                    throw new Error(
                        "Inject canonical order effects for a fixture containing order or maker events",
                    );
            },
        },
        now: input.now,
    });

    function collections(ids: readonly number[]): CollectionRecord[] {
        return ids.map((id) => {
            const collection = registry.getCollection(chainId, id);
            if (!collection)
                throw new Error(`Unknown fixture collection ${id}`);
            return collection;
        });
    }

    function applied(acquisition: {
        blocks: readonly SyncBlockHeader[];
        data?: OnChainData;
        shared: boolean;
        collectionIds: readonly number[];
    }): SyncRangeResult {
        return {
            checkpoint: storage.captureSyncCheckpoint(chainId),
            application: {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: acquisition.shared
                    ? progress.chainProgress(chainId)
                    : null,
                collections: acquisition.collectionIds.map((id) => {
                    const scope = progress.collectionProgress(chainId, id);
                    if (!scope)
                        throw new Error(
                            `Fixture collection ${id} has no accepted base`,
                        );
                    return scope;
                }),
            },
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            blocks: acquisition.blocks,
            data: acquisition.data ?? emptyOnChainData(),
            collections: collections(acquisition.collectionIds),
        };
    }

    function historical(acquisition: {
        blocks: readonly SyncBlockHeader[];
        data?: OnChainData;
        collectionIds: readonly number[];
    }): SyncRangeResult {
        return {
            checkpoint: storage.captureSyncCheckpoint(chainId),
            application: { kind: SYNC_APPLICATION_KIND.Historical },
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            blocks: acquisition.blocks,
            data: acquisition.data ?? emptyOnChainData(),
            collections: collections(acquisition.collectionIds),
        };
    }

    function commit(
        result: SyncRangeResult,
        followUps: readonly SyncFollowUp[] = [],
        completion: SyncWorkCompletion = {
            kind: SYNC_WORK_COMPLETION.Unmanaged,
        },
    ): void {
        writer.commitSyncRange({ result, followUps, completion });
    }
    return {
        storage,
        progress,
        registry,
        outbox,
        writer,
        applied,
        historical,
        commit,
    };
}
