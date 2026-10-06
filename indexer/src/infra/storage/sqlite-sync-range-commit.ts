import { db } from "@artgod/shared/database";
import { assertSyncFollowUpsMatchBlocks } from "../../domain/sync-result.js";
import type {
    SyncRangeCommit,
    SyncRangeCommitPort,
} from "../../ports/sync-range-commit.js";
import type { StoragePort } from "../../ports/storage.js";
import type { SqliteQueueOutbox } from "../queue/sqlite-queue-outbox.js";

// This adapter owns the writer boundary shared by data and required follow-ups.
// RPC acquisition and broker publication happen outside this transaction.
export class SqliteSyncRangeCommit implements SyncRangeCommitPort {
    constructor(
        private readonly storage: StoragePort,
        private readonly outbox: SqliteQueueOutbox,
    ) {}

    commitSyncRange({ result, followUps }: SyncRangeCommit): void {
        db.writeTransaction(() => {
            assertSyncFollowUpsMatchBlocks({
                chainId: result.checkpoint.chainId,
                blocks: result.blocks,
                collectionIds: result.collections.map(
                    (collection) => collection.id,
                ),
                followUps,
            });
            this.storage.persistSyncResult(result);
            for (const followUp of followUps)
                this.outbox.enqueueSyncFollowUp({
                    followUp,
                    revision: result.checkpoint.revision,
                });
        })();
    }
}
