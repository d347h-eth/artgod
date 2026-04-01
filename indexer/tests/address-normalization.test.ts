import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
} from "../src/domain/orders.js";
import { CollectionRecord } from "../src/domain/collections.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";

describe("address normalization at indexer write boundaries", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec(
            [
                "DELETE FROM bootstrap_metadata_snapshot_tasks;",
                "DELETE FROM nft_balance_snapshots;",
                "DELETE FROM orders;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("lowercases collection addresses when collections are upserted", () => {
        const registry = new SqliteCollectionRegistry();
        const record = CollectionRecord.fromPersistence({
            chainId: 1,
            id: 1,
            slug: "terraforms",
            address: "0xAbCd000000000000000000000000000000000000",
            standard: "erc721",
            status: "live",
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            deploymentBlock: null,
            bootstrapAnchorBlock: null,
            bootstrapStartedAt: null,
            bootstrapFinishedAt: null,
            bootstrapLastSyncedBlock: null,
            openseaSlug: null,
            openseaStatus: null,
            openseaReadyAt: null,
            openseaSnapshotStartedAt: null,
            openseaSnapshotCompletedAt: null,
            openseaReconcileStartedAt: null,
            openseaReconcileCompletedAt: null,
            openseaLastStreamEventAt: null,
            openseaLastStreamHealthyAt: null,
            openseaLastError: null,
        });

        registry.upsertCollection(record);

        const row = db
            .prepare<{ address: string }>(
                "SELECT address FROM collections WHERE chain_id = 1 AND slug = 'terraforms' LIMIT 1",
            )
            .get();

        expect(row?.address).toBe("0xabcd000000000000000000000000000000000000");
    });

    it("lowercases bootstrap snapshot and metadata-task contract fields", () => {
        const storage = new SqliteBootstrapStorage();

        storage.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId: 7,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "5081",
                owner: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
                anchorBlock: 100,
            },
        ]);
        storage.insertMetadataTasks([
            {
                runId: 1,
                chainId: 1,
                collectionId: 7,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "5081",
                standard: "erc721",
                anchorBlock: 100,
                anchorHash: `0x${"11".repeat(32)}`,
                anchorTimestamp: 1_726_000_000,
            },
        ]);

        const snapshot = db
            .prepare<{ contract_address: string; owner: string }>(
                "SELECT contract_address, owner FROM nft_balance_snapshots LIMIT 1",
            )
            .get();
        const task = db
            .prepare<{ contract_address: string }>(
                "SELECT contract_address FROM bootstrap_metadata_snapshot_tasks LIMIT 1",
            )
            .get();

        expect(snapshot).toEqual({
            contract_address: "0xabcd000000000000000000000000000000000000",
            owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        expect(task?.contract_address).toBe(
            "0xabcd000000000000000000000000000000000000",
        );
    });

    it("lowercases order address fields on upsert", async () => {
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async () => ({ status: "fillable", reason: "test" }),
        );

        await domain.handleOrderUpsert({
            chainId: 1,
            collectionId: 7,
            orderId: "0xOrder",
            kind: "seaport",
            side: "sell",
            maker: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            taker: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
            contract: "0xAbCd000000000000000000000000000000000000",
            tokenId: "5081",
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
            localTokenSetStatus: ORDER_LOCAL_TOKEN_SET_STATUS.None,
            price: "1",
            currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            source: "opensea",
            sourceStatus: ORDER_SOURCE_STATUS.Active,
            rawSourceKind: "stream",
            validateAfterUpsert: true,
        });

        const row = db
            .prepare<{
                maker: string;
                taker: string | null;
                contract_address: string;
                currency: string | null;
            }>(
                "SELECT maker, taker, contract_address, currency FROM orders WHERE chain_id = 1 AND id = '0xOrder' LIMIT 1",
            )
            .get();

        expect(row).toEqual({
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            taker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            contract_address: "0xabcd000000000000000000000000000000000000",
            currency: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        });
    });
});
