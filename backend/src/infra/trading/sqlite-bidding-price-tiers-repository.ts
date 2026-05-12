import { randomUUID } from "node:crypto";
import { db, type BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    TRADING_JOB_STATUS,
    type PersistedBiddingPriceTierRecord,
    type TradingBiddingPriceTierCeilingConfig,
    type TradingBiddingPriceTierFloorConfig,
    type TradingBiddingPriceTierStatus,
} from "@artgod/shared/types";
import type {
    BiddingPriceTierResolutionUpdate,
    BiddingPriceTiersRepositoryPort,
    UpsertBiddingPriceTierRecordInput,
} from "../../application/use-cases/trading/bidding-price-tier-ports.js";

type BiddingPriceTierRow = {
    tier_id: string;
    chain_id: number;
    collection_id: number;
    name: string;
    status: TradingBiddingPriceTierStatus;
    sort_order: number;
    parent_tier_id: string | null;
    floor_config_json: string;
    ceiling_config_json: string;
    resolved_floor_wei: string | null;
    resolved_ceiling_wei: string | null;
    resolved_at: string | null;
    last_error: string | null;
    revision: number;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
};

export class SqliteBiddingPriceTiersRepository
    implements BiddingPriceTiersRepositoryPort
{
    private readonly selectCollectionPriceTiers: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        includeArchived: number;
    }>;

    private readonly selectPriceTierById: BetterSqlite3NamedStatement<{
        tierId: string;
    }>;

    private readonly insertPriceTier: BetterSqlite3NamedStatement<{
        tierId: string;
        chainId: number;
        collectionId: number;
        name: string;
        status: Exclude<TradingBiddingPriceTierStatus, "archived">;
        sortOrder: number;
        parentTierId: string | null;
        floorConfigJson: string;
        ceilingConfigJson: string;
        resolvedFloorWei: string;
        resolvedCeilingWei: string;
        resolvedAt: string;
        lastError: string | null;
    }>;

    private readonly updatePriceTier: BetterSqlite3NamedStatement<{
        tierId: string;
        name: string;
        status: Exclude<TradingBiddingPriceTierStatus, "archived">;
        sortOrder: number;
        parentTierId: string | null;
        floorConfigJson: string;
        ceilingConfigJson: string;
        resolvedFloorWei: string;
        resolvedCeilingWei: string;
        resolvedAt: string;
        lastError: string | null;
    }>;

    private readonly archiveTierById: BetterSqlite3NamedStatement<{
        tierId: string;
    }>;

    private readonly updatePriceTierResolution: BetterSqlite3NamedStatement<{
        tierId: string;
        resolvedFloorWei: string;
        resolvedCeilingWei: string;
        resolvedAt: string;
        lastError: string | null;
    }>;

    constructor() {
        this.selectCollectionPriceTiers = db.prepare<{
            chainId: number;
            collectionId: number;
            includeArchived: number;
        }>(
            "SELECT tier_id, chain_id, collection_id, name, status, sort_order, parent_tier_id, " +
                "floor_config_json, ceiling_config_json, resolved_floor_wei, resolved_ceiling_wei, " +
                "resolved_at, last_error, revision, created_at, updated_at, archived_at " +
                "FROM trading_bidding_price_tiers " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND (@includeArchived = 1 OR status != 'archived') " +
                "ORDER BY sort_order ASC, name ASC, tier_id ASC",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            includeArchived: number;
        }>;

        this.selectPriceTierById = db.prepare<{ tierId: string }>(
            "SELECT tier_id, chain_id, collection_id, name, status, sort_order, parent_tier_id, " +
                "floor_config_json, ceiling_config_json, resolved_floor_wei, resolved_ceiling_wei, " +
                "resolved_at, last_error, revision, created_at, updated_at, archived_at " +
                "FROM trading_bidding_price_tiers WHERE tier_id = @tierId LIMIT 1",
        ) as BetterSqlite3NamedStatement<{ tierId: string }>;

        this.insertPriceTier = db.prepare<{
            tierId: string;
            chainId: number;
            collectionId: number;
            name: string;
            status: Exclude<TradingBiddingPriceTierStatus, "archived">;
            sortOrder: number;
            parentTierId: string | null;
            floorConfigJson: string;
            ceilingConfigJson: string;
            resolvedFloorWei: string;
            resolvedCeilingWei: string;
            resolvedAt: string;
            lastError: string | null;
        }>(
            "INSERT INTO trading_bidding_price_tiers " +
                "(tier_id, chain_id, collection_id, name, status, sort_order, parent_tier_id, floor_config_json, ceiling_config_json, resolved_floor_wei, resolved_ceiling_wei, resolved_at, last_error) " +
                "VALUES (@tierId, @chainId, @collectionId, @name, @status, @sortOrder, @parentTierId, @floorConfigJson, @ceilingConfigJson, @resolvedFloorWei, @resolvedCeilingWei, @resolvedAt, @lastError)",
        ) as BetterSqlite3NamedStatement<{
            tierId: string;
            chainId: number;
            collectionId: number;
            name: string;
            status: Exclude<TradingBiddingPriceTierStatus, "archived">;
            sortOrder: number;
            parentTierId: string | null;
            floorConfigJson: string;
            ceilingConfigJson: string;
            resolvedFloorWei: string;
            resolvedCeilingWei: string;
            resolvedAt: string;
            lastError: string | null;
        }>;

        this.updatePriceTier = db.prepare<{
            tierId: string;
            name: string;
            status: Exclude<TradingBiddingPriceTierStatus, "archived">;
            sortOrder: number;
            parentTierId: string | null;
            floorConfigJson: string;
            ceilingConfigJson: string;
            resolvedFloorWei: string;
            resolvedCeilingWei: string;
            resolvedAt: string;
            lastError: string | null;
        }>(
            "UPDATE trading_bidding_price_tiers SET " +
                "name = @name, status = @status, sort_order = @sortOrder, parent_tier_id = @parentTierId, " +
                "floor_config_json = @floorConfigJson, ceiling_config_json = @ceilingConfigJson, " +
                "resolved_floor_wei = @resolvedFloorWei, resolved_ceiling_wei = @resolvedCeilingWei, " +
                "resolved_at = @resolvedAt, last_error = @lastError, archived_at = NULL, " +
                "revision = revision + 1, updated_at = CURRENT_TIMESTAMP " +
                "WHERE tier_id = @tierId",
        ) as BetterSqlite3NamedStatement<{
            tierId: string;
            name: string;
            status: Exclude<TradingBiddingPriceTierStatus, "archived">;
            sortOrder: number;
            parentTierId: string | null;
            floorConfigJson: string;
            ceilingConfigJson: string;
            resolvedFloorWei: string;
            resolvedCeilingWei: string;
            resolvedAt: string;
            lastError: string | null;
        }>;

        this.archiveTierById = db.prepare<{ tierId: string }>(
            "UPDATE trading_bidding_price_tiers SET " +
                "status = 'archived', archived_at = CURRENT_TIMESTAMP, revision = revision + 1, updated_at = CURRENT_TIMESTAMP " +
                "WHERE tier_id = @tierId",
        ) as BetterSqlite3NamedStatement<{ tierId: string }>;

        this.updatePriceTierResolution = db.prepare<{
            tierId: string;
            resolvedFloorWei: string;
            resolvedCeilingWei: string;
            resolvedAt: string;
            lastError: string | null;
        }>(
            "UPDATE trading_bidding_price_tiers SET " +
                "resolved_floor_wei = @resolvedFloorWei, resolved_ceiling_wei = @resolvedCeilingWei, " +
                "resolved_at = @resolvedAt, last_error = @lastError, updated_at = CURRENT_TIMESTAMP " +
                "WHERE tier_id = @tierId",
        ) as BetterSqlite3NamedStatement<{
            tierId: string;
            resolvedFloorWei: string;
            resolvedCeilingWei: string;
            resolvedAt: string;
            lastError: string | null;
        }>;
    }

    listCollectionPriceTiers(params: {
        chainId: number;
        collectionId: number;
        includeArchived?: boolean;
    }): PersistedBiddingPriceTierRecord[] {
        const rows = this.selectCollectionPriceTiers.all({
            chainId: params.chainId,
            collectionId: params.collectionId,
            includeArchived: params.includeArchived ? 1 : 0,
        }) as BiddingPriceTierRow[];
        return rows.map((row) => this.mapPriceTierRow(row));
    }

    getPriceTierById(tierId: string): PersistedBiddingPriceTierRecord | null {
        const row = this.selectPriceTierById.get({
            tierId,
        }) as BiddingPriceTierRow | undefined;
        return row ? this.mapPriceTierRow(row) : null;
    }

    upsertPriceTier(
        input: UpsertBiddingPriceTierRecordInput,
    ): PersistedBiddingPriceTierRecord {
        return db.raw.transaction((transactionInput) => {
            const tierId = transactionInput.tierId ?? randomUUID();
            const payload = {
                tierId,
                chainId: transactionInput.chainId,
                collectionId: transactionInput.collectionId,
                name: transactionInput.name,
                status: transactionInput.status,
                sortOrder: transactionInput.sortOrder,
                parentTierId: transactionInput.parentTierId,
                floorConfigJson: JSON.stringify(transactionInput.floorConfig),
                ceilingConfigJson: JSON.stringify(transactionInput.ceilingConfig),
                resolvedFloorWei: transactionInput.resolvedFloorWei,
                resolvedCeilingWei: transactionInput.resolvedCeilingWei,
                resolvedAt: transactionInput.resolvedAt,
                lastError: transactionInput.lastError,
            };

            if (transactionInput.tierId && this.getPriceTierById(tierId)) {
                this.updatePriceTier.run(payload);
            } else {
                this.insertPriceTier.run(payload);
            }

            const saved = this.getPriceTierById(tierId);
            if (!saved) {
                throw new Error(`Failed to reload bidding price tier ${tierId}`);
            }
            return saved;
        })(input);
    }

    archivePriceTier(tierId: string): PersistedBiddingPriceTierRecord | null {
        return db.raw.transaction((transactionTierId: string) => {
            const existing = this.getPriceTierById(transactionTierId);
            if (!existing || existing.status === TRADING_JOB_STATUS.Archived) {
                return existing;
            }
            this.archiveTierById.run({ tierId: transactionTierId });
            return this.getPriceTierById(transactionTierId);
        })(tierId);
    }

    updatePriceTierResolutions(
        resolutions: BiddingPriceTierResolutionUpdate[],
    ): void {
        db.raw.transaction((transactionResolutions) => {
            for (const resolution of transactionResolutions) {
                this.updatePriceTierResolution.run(resolution);
            }
        })(resolutions);
    }

    private mapPriceTierRow(
        row: BiddingPriceTierRow,
    ): PersistedBiddingPriceTierRecord {
        return {
            tierId: row.tier_id,
            chainId: row.chain_id,
            collectionId: row.collection_id,
            name: row.name,
            status: row.status,
            sortOrder: row.sort_order,
            parentTierId: row.parent_tier_id,
            floorConfig: parseJsonConfig<TradingBiddingPriceTierFloorConfig>(
                row.floor_config_json,
                row.tier_id,
                "floor_config_json",
            ),
            ceilingConfig: parseJsonConfig<TradingBiddingPriceTierCeilingConfig>(
                row.ceiling_config_json,
                row.tier_id,
                "ceiling_config_json",
            ),
            resolvedFloorWei: row.resolved_floor_wei,
            resolvedCeilingWei: row.resolved_ceiling_wei,
            resolvedAt: row.resolved_at,
            lastError: row.last_error,
            revision: row.revision,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            archivedAt: row.archived_at,
        };
    }
}

function parseJsonConfig<T>(raw: string, tierId: string, field: string): T {
    try {
        return JSON.parse(raw) as T;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ${field} for bidding price tier ${tierId}: ${message}`);
    }
}
