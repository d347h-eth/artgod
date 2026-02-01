import { db } from "@artgod/shared/database";
import type { ConduitRecord, ConduitRegistryPort } from "../../ports/conduits.js";

type ConduitRow = {
    conduit_address: string;
};

export class SqliteConduitRegistry implements ConduitRegistryPort {
    private select = db.prepare<[number, string]>(
        "SELECT conduit_address FROM seaport_conduits " +
            "WHERE chain_id = ? AND conduit_key = ?",
    );
    private upsert = db.prepare<[number, string, string]>(
        "INSERT INTO seaport_conduits (chain_id, conduit_key, conduit_address) " +
            "VALUES (?, ?, ?) " +
            "ON CONFLICT(chain_id, conduit_key) DO UPDATE SET " +
            "conduit_address = excluded.conduit_address, " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    getConduit(chainId: number, conduitKey: string): string | null {
        const row = this.select.get(
            chainId,
            conduitKey.toLowerCase(),
        ) as ConduitRow | undefined;
        return row?.conduit_address ?? null;
    }

    upsertConduit(record: ConduitRecord): void {
        this.upsert.run(
            record.chainId,
            record.conduitKey.toLowerCase(),
            record.conduitAddress.toLowerCase(),
        );
    }
}
