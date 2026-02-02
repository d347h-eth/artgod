import { db } from "@artgod/shared/database";
import type {
    BootstrapSnapshotPort,
    BootstrapSnapshotRow,
    SnapshotFinalizeInput,
} from "../../ports/bootstrap.js";

const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

export class SqliteBootstrapStorage implements BootstrapSnapshotPort {
    private resetSnapshotStmt = db.prepare<{
        chainId: number;
        collectionId: string;
    }>(
        "DELETE FROM nft_balance_snapshots " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private insertSnapshotStmt = db.prepare<BootstrapSnapshotRow>(
        "INSERT INTO nft_balance_snapshots " +
            "(chain_id, collection_id, contract_address, token_id, owner, anchor_block) " +
            "VALUES (@chainId, @collectionId, @contract, @tokenId, @owner, @anchorBlock)",
    );
    private deleteBalancesStmt = db.prepare<{
        chainId: number;
        contract: string;
    }>(
        "DELETE FROM nft_balances WHERE chain_id = @chainId AND contract_address = @contract",
    );
    private insertBalancesFromSnapshotStmt = db.prepare<{
        chainId: number;
        collectionId: string;
        contract: string;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
        zeroHash: string;
    }>(
        "INSERT INTO nft_balances " +
            "(chain_id, contract_address, token_id, owner, amount, " +
            "last_block_number, last_block_hash, last_block_timestamp, " +
            "last_tx_hash, last_log_index, updated_at) " +
            "SELECT chain_id, contract_address, token_id, owner, '1', " +
            "@anchorBlock, @anchorHash, @anchorTimestamp, " +
            "@zeroHash, 0, CURRENT_TIMESTAMP " +
            "FROM nft_balance_snapshots " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );

    resetSnapshot(chainId: number, collectionId: string): void {
        this.resetSnapshotStmt.run({ chainId, collectionId });
    }

    insertSnapshotRows(rows: BootstrapSnapshotRow[]): void {
        if (rows.length === 0) return;
        const insertMany = db.raw.transaction(
            (batch: BootstrapSnapshotRow[]) => {
                for (const row of batch) {
                    this.insertSnapshotStmt.run(row);
                }
            },
        );
        insertMany(rows);
    }

    finalizeSnapshot(input: SnapshotFinalizeInput): void {
        const finalize = db.raw.transaction((params: SnapshotFinalizeInput) => {
            this.deleteBalancesStmt.run({
                chainId: params.chainId,
                contract: params.contract,
            });
            this.insertBalancesFromSnapshotStmt.run({
                chainId: params.chainId,
                collectionId: params.collectionId,
                contract: params.contract,
                anchorBlock: params.anchorBlock,
                anchorHash: params.anchorHash,
                anchorTimestamp: params.anchorTimestamp,
                zeroHash: ZERO_HASH,
            });
        });
        finalize(input);
    }
}
