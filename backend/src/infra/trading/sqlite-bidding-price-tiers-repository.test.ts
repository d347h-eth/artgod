import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
} from "@artgod/shared/types";
import { SqliteBiddingPriceTiersRepository } from "./sqlite-bidding-price-tiers-repository.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bidding-price-tiers-"));
    return join(dir, "main.sqlite");
}

function seedCollection(): number {
    const result = db.prepare<{
        chainId: number;
        slug: string;
        address: string;
        standard: string;
        status: string;
        tokenScopeKind: string;
        openseaSlug: string;
    }>(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
            "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @openseaSlug)",
    ).run({
        chainId: 1,
        slug: "artgod-slug",
        address: "0x1111111111111111111111111111111111111111",
        standard: "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
        openseaSlug: "terraforms",
    });

    return Number(result.lastInsertRowid);
}

describe("SqliteBiddingPriceTiersRepository", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    it("persists and reloads bidding price tier configs and resolved scalar values", () => {
        const repository = new SqliteBiddingPriceTiersRepository();

        const tier = repository.upsertPriceTier({
            chainId: 1,
            collectionId,
            name: "Root",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 1,
            parentTierId: null,
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                valueEth: "1",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.25",
            },
            deltaWei: "1000000000000000",
            resolvedFloorWei: "1000000000000000000",
            resolvedCeilingWei: "1250000000000000000",
            resolvedAt: "2026-05-12T01:00:00Z",
            lastError: null,
        });

        assert.equal(tier.name, "Root");
        assert.equal(tier.revision, 1);
        assert.equal(tier.resolvedFloorWei, "1000000000000000000");
        assert.equal(tier.resolvedCeilingWei, "1250000000000000000");
        assert.equal(tier.deltaWei, "1000000000000000");

        const listed = repository.listCollectionPriceTiers({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.deepEqual(listed[0]?.floorConfig, tier.floorConfig);
    });

    it("enforces only one active child per parent", () => {
        const repository = new SqliteBiddingPriceTiersRepository();
        const parent = repository.upsertPriceTier({
            chainId: 1,
            collectionId,
            name: "Root",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 1,
            parentTierId: null,
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                valueEth: "1",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
                valueEth: "1.2",
            },
            deltaWei: "1000000000000000",
            resolvedFloorWei: "1000000000000000000",
            resolvedCeilingWei: "1200000000000000000",
            resolvedAt: "2026-05-12T01:00:00Z",
            lastError: null,
        });

        repository.upsertPriceTier({
            chainId: 1,
            collectionId,
            name: "Child A",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 2,
            parentTierId: parent.tierId,
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.1",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta,
                deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                deltaEth: "0.1",
            },
            deltaWei: "1000000000000000",
            resolvedFloorWei: "1100000000000000000",
            resolvedCeilingWei: "1300000000000000000",
            resolvedAt: "2026-05-12T01:00:00Z",
            lastError: null,
        });

        assert.throws(() =>
            repository.upsertPriceTier({
                chainId: 1,
                collectionId,
                name: "Child B",
                status: TRADING_JOB_STATUS.Enabled,
                sortOrder: 3,
                parentTierId: parent.tierId,
                floorConfig: {
                    kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
                    deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                    deltaEth: "0.2",
                },
                ceilingConfig: {
                    kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta,
                    deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute,
                    deltaEth: "0.2",
                },
                deltaWei: "1000000000000000",
                resolvedFloorWei: "1200000000000000000",
                resolvedCeilingWei: "1400000000000000000",
                resolvedAt: "2026-05-12T01:00:00Z",
                lastError: null,
            }),
        );
    });

    it("archives tiers, hides them from active lists, and keeps archive idempotent", () => {
        const repository = new SqliteBiddingPriceTiersRepository();
        const tier = repository.upsertPriceTier({
            chainId: 1,
            collectionId,
            name: "Archive Me",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 1,
            parentTierId: null,
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                valueEth: "1",
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
                valueEth: "1.2",
            },
            deltaWei: "1000000000000000",
            resolvedFloorWei: "1000000000000000000",
            resolvedCeilingWei: "1200000000000000000",
            resolvedAt: "2026-05-12T01:00:00Z",
            lastError: null,
        });

        const archived = repository.archivePriceTier(tier.tierId);

        assert.equal(archived?.status, TRADING_JOB_STATUS.Archived);
        assert.equal(archived?.revision, tier.revision + 1);
        assert.ok(archived?.archivedAt);
        assert.deepEqual(
            repository.listCollectionPriceTiers({
                chainId: 1,
                collectionId,
            }),
            [],
        );
        assert.deepEqual(
            repository
                .listCollectionPriceTiers({
                    chainId: 1,
                    collectionId,
                    includeArchived: true,
                })
                .map((listedTier) => listedTier.tierId),
            [tier.tierId],
        );

        const archivedAgain = repository.archivePriceTier(tier.tierId);
        assert.equal(archivedAgain?.revision, archived?.revision);
        assert.equal(repository.archivePriceTier("missing"), null);
    });
});
