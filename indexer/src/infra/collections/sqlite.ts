import { db } from "@artgod/shared/database";
import type {
    CollectionRecord,
    CollectionUpsertInput,
} from "../../domain/collections.js";
import type {
    CollectionRegistryPort,
    CollectionSyncMode,
} from "../../ports/collections.js";

type CollectionRow = {
    chain_id: number;
    collection_id: string;
    address: string;
    standard: string;
    status: string;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
};

export class SqliteCollectionRegistry implements CollectionRegistryPort {
    private selectLive = db.prepare<{ chainId: number }>(
        "SELECT chain_id, collection_id, address, standard, status, deployment_block, bootstrap_anchor_block " +
            "FROM collections WHERE chain_id = @chainId AND status = 'live'",
    );
    private selectBackfill = db.prepare<{ chainId: number }>(
        "SELECT chain_id, collection_id, address, standard, status, deployment_block, bootstrap_anchor_block " +
            "FROM collections WHERE chain_id = @chainId AND status IN ('live', 'bootstrapping')",
    );
    private upsert = db.prepare<{
        chainId: number;
        id: string;
        address: string;
        standard: string;
        status: string;
        deploymentBlock: number | null;
        bootstrapAnchorBlock: number | null;
    }>(
        "INSERT INTO collections " +
            "(chain_id, collection_id, address, standard, status, deployment_block, bootstrap_anchor_block) " +
            "VALUES (@chainId, @id, @address, @standard, @status, @deploymentBlock, @bootstrapAnchorBlock) " +
            "ON CONFLICT(chain_id, collection_id) DO UPDATE SET " +
            "address = excluded.address, standard = excluded.standard, status = excluded.status, " +
            "deployment_block = excluded.deployment_block, bootstrap_anchor_block = excluded.bootstrap_anchor_block, " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    listCollectionsForSync(
        chainId: number,
        mode: CollectionSyncMode,
    ): CollectionRecord[] {
        const rows =
            mode === "realtime"
                ? (this.selectLive.all({ chainId }) as CollectionRow[])
                : (this.selectBackfill.all({ chainId }) as CollectionRow[]);
        return rows.map(mapRow);
    }

    upsertCollection(input: CollectionUpsertInput): void {
        this.upsert.run({
            chainId: input.chainId,
            id: input.id,
            address: input.address,
            standard: input.standard,
            status: input.status,
            deploymentBlock: input.deploymentBlock,
            bootstrapAnchorBlock: input.bootstrapAnchorBlock,
        });
    }
}

function mapRow(row: CollectionRow): CollectionRecord {
    return {
        chainId: row.chain_id,
        id: row.collection_id,
        address: row.address,
        standard: row.standard as CollectionRecord["standard"],
        status: row.status as CollectionRecord["status"],
        deploymentBlock: row.deployment_block,
        bootstrapAnchorBlock: row.bootstrap_anchor_block,
    };
}
