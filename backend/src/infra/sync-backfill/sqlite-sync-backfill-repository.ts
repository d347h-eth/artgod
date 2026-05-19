import { db } from "@artgod/shared/database";
import type {
    SyncBackfillCollectionOption,
    SyncBackfillCoverageContext,
    SyncBackfillCoverageCount,
    SyncBackfillCoverageRange,
    SyncBackfillReadPort,
} from "../../application/use-cases/sync-backfill/get-sync-backfill-state.js";

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    status: "live";
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    bootstrap_last_synced_block: number | null;
};

type CountRow = {
    count: number;
};

type MaxBlockRow = {
    max_block_number: number | null;
};

type BlockTimestampRow = {
    timestamp: number;
};

const COLLECTION_COLUMNS =
    "chain_id, collection_id, slug, address, status, deployment_block, bootstrap_anchor_block, bootstrap_last_synced_block";

export class SqliteSyncBackfillRepository implements SyncBackfillReadPort {
    private selectLiveCollections = db.prepare<{ chainId: number }>(
        `SELECT ${COLLECTION_COLUMNS} ` +
            "FROM collections " +
            "WHERE chain_id = @chainId AND status = 'live' " +
            "AND bootstrap_anchor_block IS NOT NULL " +
            "ORDER BY slug ASC",
    );
    private selectMaxSyncedBlock = db.prepare<{ chainId: number }>(
        "SELECT MAX(block_number) AS max_block_number FROM blocks WHERE chain_id = @chainId",
    );
    private selectBlockTimestamp = db.prepare<{
        chainId: number;
        blockNumber: number;
    }>(
        "SELECT timestamp FROM blocks " +
            "WHERE chain_id = @chainId AND block_number = @blockNumber",
    );
    private countAnySyncedBlocksStmt = db.prepare<{ chainId: number }>(
        "SELECT COUNT(1) AS count FROM blocks WHERE chain_id = @chainId",
    );
    private countCollectionSyncedBlocksStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT COUNT(1) AS count FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private countAnySyncedBlocksInRangeStmt = db.prepare<{
        chainId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "SELECT COUNT(1) AS count FROM blocks " +
            "WHERE chain_id = @chainId AND block_number BETWEEN @fromBlock AND @toBlock",
    );
    private countCollectionSyncedBlocksInRangeStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "SELECT COUNT(1) AS count FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND block_number BETWEEN @fromBlock AND @toBlock",
    );

    listLiveCollections(chainId: number): SyncBackfillCollectionOption[] {
        const rows = this.selectLiveCollections.all({
            chainId,
        }) as CollectionRow[];
        return rows.map((row) => ({
            chainId: row.chain_id,
            collectionId: row.collection_id,
            slug: row.slug,
            address: row.address,
            status: row.status,
            deploymentBlock: row.deployment_block,
            bootstrapAnchorBlock: row.bootstrap_anchor_block,
            bootstrapLastSyncedBlock: row.bootstrap_last_synced_block,
        }));
    }

    getHighestSyncedBlock(chainId: number): number | null {
        const row = this.selectMaxSyncedBlock.get({
            chainId,
        }) as MaxBlockRow | undefined;
        return row?.max_block_number ?? null;
    }

    getBlockTimestamp(chainId: number, blockNumber: number): number | null {
        const row = this.selectBlockTimestamp.get({
            chainId,
            blockNumber,
        }) as BlockTimestampRow | undefined;
        return row?.timestamp ?? null;
    }

    countSyncedBlocks(
        chainId: number,
        context: SyncBackfillCoverageContext,
    ): number {
        if (context.kind === "collection") {
            return readCount(
                this.countCollectionSyncedBlocksStmt.get({
                    chainId,
                    collectionId: context.collectionId,
                }),
            );
        }
        return readCount(this.countAnySyncedBlocksStmt.get({ chainId }));
    }

    countSyncedBlocksInRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        range: SyncBackfillCoverageRange,
    ): number {
        if (range.fromBlock > range.toBlock) return 0;
        if (context.kind === "collection") {
            return readCount(
                this.countCollectionSyncedBlocksInRangeStmt.get({
                    chainId,
                    collectionId: context.collectionId,
                    fromBlock: range.fromBlock,
                    toBlock: range.toBlock,
                }),
            );
        }
        return readCount(
            this.countAnySyncedBlocksInRangeStmt.get({
                chainId,
                fromBlock: range.fromBlock,
                toBlock: range.toBlock,
            }),
        );
    }

    countSyncedBlocksByRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        ranges: SyncBackfillCoverageRange[],
    ): SyncBackfillCoverageCount[] {
        return ranges.map((range) => ({
            ...range,
            syncedBlockCount: this.countSyncedBlocksInRange(
                chainId,
                context,
                range,
            ),
        }));
    }
}

function readCount(row: unknown): number {
    return (row as CountRow | undefined)?.count ?? 0;
}
