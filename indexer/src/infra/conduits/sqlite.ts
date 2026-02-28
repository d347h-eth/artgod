import { db } from "@artgod/shared/database";
import type {
    ConduitRecord,
    ConduitRegistryPort,
} from "../../ports/conduits.js";

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
    private selectChannel = db.prepare<[number, string, string]>(
        "SELECT 1 FROM seaport_conduit_channels " +
            "WHERE chain_id = ? AND conduit_address = ? AND channel_address = ?",
    );
    private deleteChannels = db.prepare<[number, string]>(
        "DELETE FROM seaport_conduit_channels WHERE chain_id = ? AND conduit_address = ?",
    );
    private insertChannel = db.prepare<[number, string, string]>(
        "INSERT INTO seaport_conduit_channels (chain_id, conduit_address, channel_address) " +
            "VALUES (?, ?, ?) " +
            "ON CONFLICT(chain_id, conduit_address, channel_address) DO UPDATE SET " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    getConduit(chainId: number, conduitKey: string): string | null {
        const row = this.select.get(chainId, conduitKey.toLowerCase()) as
            | ConduitRow
            | undefined;
        return row?.conduit_address ?? null;
    }

    upsertConduit(record: ConduitRecord): void {
        this.upsert.run(
            record.chainId,
            record.conduitKey.toLowerCase(),
            record.conduitAddress.toLowerCase(),
        );
    }

    hasChannel(
        chainId: number,
        conduitAddress: string,
        channelAddress: string,
    ): boolean {
        const row = this.selectChannel.get(
            chainId,
            conduitAddress.toLowerCase(),
            channelAddress.toLowerCase(),
        );
        return Boolean(row);
    }

    replaceChannels(
        chainId: number,
        conduitAddress: string,
        channels: string[],
    ): void {
        const replace = db.raw.transaction(
            (payload: {
                chainId: number;
                conduitAddress: string;
                channels: string[];
            }) => {
                this.deleteChannels.run(
                    payload.chainId,
                    payload.conduitAddress.toLowerCase(),
                );
                for (const channel of payload.channels) {
                    this.insertChannel.run(
                        payload.chainId,
                        payload.conduitAddress.toLowerCase(),
                        channel.toLowerCase(),
                    );
                }
            },
        );
        replace({ chainId, conduitAddress, channels });
    }
}
