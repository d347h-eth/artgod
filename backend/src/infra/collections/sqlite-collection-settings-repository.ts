import { db, type BetterSqlite3NamedStatement } from "@artgod/shared/database";
import type { PersistedCollectionSettingRecord } from "@artgod/shared/types";
import type {
    CollectionSettingsRepositoryPort,
    UpsertCollectionSettingInput,
} from "../../application/use-cases/trading/bidding-price-tier-ports.js";

type CollectionSettingRow = {
    chain_id: number;
    collection_id: number;
    setting_key: string;
    value_json: string;
    created_at: string;
    updated_at: string;
};

export class SqliteCollectionSettingsRepository
    implements CollectionSettingsRepositoryPort
{
    private readonly selectSetting: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        key: string;
    }>;

    private readonly upsertSetting: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        key: string;
        valueJson: string;
    }>;

    constructor() {
        this.selectSetting = db.prepare<{
            chainId: number;
            collectionId: number;
            key: string;
        }>(
            "SELECT chain_id, collection_id, setting_key, value_json, created_at, updated_at " +
                "FROM collection_settings " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId AND setting_key = @key LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            key: string;
        }>;

        this.upsertSetting = db.prepare<{
            chainId: number;
            collectionId: number;
            key: string;
            valueJson: string;
        }>(
            "INSERT INTO collection_settings " +
                "(chain_id, collection_id, setting_key, value_json) " +
                "VALUES (@chainId, @collectionId, @key, @valueJson) " +
                "ON CONFLICT(chain_id, collection_id, setting_key) DO UPDATE SET " +
                "value_json = excluded.value_json, " +
                "updated_at = CURRENT_TIMESTAMP",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            key: string;
            valueJson: string;
        }>;
    }

    getCollectionSetting(params: {
        chainId: number;
        collectionId: number;
        key: string;
    }): PersistedCollectionSettingRecord | null {
        const row = this.selectSetting.get(params) as
            | CollectionSettingRow
            | undefined;
        return row ? mapSettingRow(row) : null;
    }

    upsertCollectionSetting(
        input: UpsertCollectionSettingInput,
    ): PersistedCollectionSettingRecord {
        this.upsertSetting.run(input);
        const record = this.getCollectionSetting(input);
        if (!record) {
            throw new Error("collection setting was not persisted");
        }
        return record;
    }
}

function mapSettingRow(
    row: CollectionSettingRow,
): PersistedCollectionSettingRecord {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        key: row.setting_key,
        valueJson: row.value_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
