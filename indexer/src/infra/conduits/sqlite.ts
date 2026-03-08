import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
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
        const normalizedConduitKey = conduitKey.toLowerCase();

        try {
            const row = this.select.get(chainId, normalizedConduitKey) as
                | ConduitRow
                | undefined;
            return row?.conduit_address ?? null;
        } catch (error) {
            logger.error("Conduit registry lookup failed", {
                component: "SqliteConduitRegistry",
                action: "getConduit",
                chainId,
                conduitKey: normalizedConduitKey,
                error: String(error),
            });
            throw error;
        }
    }

    upsertConduit(record: ConduitRecord): void {
        const conduitKey = record.conduitKey.toLowerCase();
        const conduitAddress = record.conduitAddress.toLowerCase();

        try {
            this.upsert.run(record.chainId, conduitKey, conduitAddress);
        } catch (error) {
            logger.error("Conduit registry upsert failed", {
                component: "SqliteConduitRegistry",
                action: "upsertConduit",
                chainId: record.chainId,
                conduitKey,
                conduitAddress,
                error: String(error),
            });
            throw error;
        }
    }

    hasChannel(
        chainId: number,
        conduitAddress: string,
        channelAddress: string,
    ): boolean {
        const normalizedConduitAddress = conduitAddress.toLowerCase();
        const normalizedChannelAddress = channelAddress.toLowerCase();

        try {
            const row = this.selectChannel.get(
                chainId,
                normalizedConduitAddress,
                normalizedChannelAddress,
            );
            return Boolean(row);
        } catch (error) {
            logger.error("Conduit channel lookup failed", {
                component: "SqliteConduitRegistry",
                action: "hasChannel",
                chainId,
                conduitAddress: normalizedConduitAddress,
                channelAddress: normalizedChannelAddress,
                error: String(error),
            });
            throw error;
        }
    }

    replaceChannels(
        chainId: number,
        conduitAddress: string,
        channels: string[],
    ): void {
        const normalizedConduitAddress = conduitAddress.toLowerCase();
        const normalizedChannels = channels.map((channel) => channel.toLowerCase());

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

        try {
            replace({
                chainId,
                conduitAddress: normalizedConduitAddress,
                channels: normalizedChannels,
            });
        } catch (error) {
            logger.error("Conduit channel replace failed", {
                component: "SqliteConduitRegistry",
                action: "replaceChannels",
                chainId,
                conduitAddress: normalizedConduitAddress,
                channelCount: normalizedChannels.length,
                channels: normalizedChannels,
                error: String(error),
            });
            throw error;
        }
    }
}
