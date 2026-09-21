import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { OpenSeaOrderbookSync } from "../src/application/offchain/opensea-orderbook-sync.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
} from "../src/domain/offchain-jobs.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const NOW = 1_800_000_000;

describe("streamed orderbook reconciliation", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug) VALUES (99,1,'fixture','0xcollection','erc721','ready','contract_all_tokens','fixture')",
        ).run();
    });
    afterEach(() => db.raw.close());

    const begin = () =>
        new SqliteOrderSourceStateStore().beginObservation({
            chainId: 1,
            collectionId: 99,
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            startedAt: NOW,
        });
    function order(id: string, observedAt = NOW - 3600) {
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,source,source_status,fillability_status,observed_at) VALUES (?,1,99,'seaport','maker','0xcollection',?,?,?,?)",
        ).run(
            id,
            OFFCHAIN_ORDER_SOURCE.OpenSea,
            ORDER_SOURCE_STATUS.Active,
            ORDER_STATUS.Fillable,
            observedAt,
        );
    }
    const status = (id: string) =>
        db.prepare("SELECT source_status FROM orders WHERE id=?").get(id);
    const tempTables = () =>
        db
            .prepare(
                "SELECT name FROM sqlite_temp_schema WHERE type='table' AND name LIKE 'market_observation_%'",
            )
            .all();

    it("deactivates absent older orders without overriding stream observations or their coalesced freshness bucket", async () => {
        order("absent");
        order("seen");
        order("during-crawl", NOW + 1);
        order("fresh-bucket", NOW - POLICY.orderRevalidationSeconds + 1);
        const observation = begin();
        expect(observation.recordActiveOrder("SEEN")).toBe(true);
        expect(await observation.complete()).toBe(1);
        expect(await observation.complete()).toBe(0);
        expect(status("absent")).toEqual({
            source_status: ORDER_SOURCE_STATUS.Inactive,
        });
        for (const id of ["seen", "during-crawl", "fresh-bucket"]) {
            expect(status(id)).toEqual({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
        }
        expect(
            db
                .prepare("SELECT observed_at FROM market_order_observations")
                .get(),
        ).toEqual({ observed_at: NOW });
        observation.close();
        observation.close();
        expect(tempTables()).toEqual([]);
    });

    it("rechecks eligibility between bounded update batches", async () => {
        db.raw.transaction(() => {
            for (let i = 0; i <= POLICY.maintenanceBatchRows; i++)
                order(String(i).padStart(5, "0"));
        })();
        const observation = begin();
        const completing = observation.complete();
        const lastId = String(POLICY.maintenanceBatchRows).padStart(5, "0");
        db.prepare("UPDATE orders SET observed_at=? WHERE id=?").run(
            NOW + 1,
            lastId,
        );
        expect(await completing).toBe(POLICY.maintenanceBatchRows);
        expect(status(lastId)).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        observation.close();
    });

    it("closes admission and does not recreate freshness state after collection deletion", async () => {
        const observation = begin();
        db.prepare("DELETE FROM collections WHERE collection_id=99").run();
        expect(observation.recordActiveOrder("late")).toBe(false);
        expect(await observation.complete()).toBe(0);
        expect(
            db.prepare("SELECT * FROM market_order_observations").all(),
        ).toEqual([]);
        observation.close();
        expect(tempTables()).toEqual([]);
    });

    it("releases its temporary membership tables when an upstream crawl fails", async () => {
        const api = {
            forEachListing: vi
                .fn()
                .mockRejectedValue(new Error("fixture failure")),
            forEachOffer: vi.fn(),
        };
        const sync = new OpenSeaOrderbookSync(
            api,
            { publish: vi.fn() },
            new SqliteOrderSourceStateStore(),
        );
        const collection = new SqliteCollectionRegistry().getCollection(1, 99)!;
        await expect(
            sync.syncCollection(
                collection,
                OFFCHAIN_OBSERVATION_CHANNEL.Snapshot,
                1,
            ),
        ).rejects.toThrow("fixture failure");
        expect(tempTables()).toEqual([]);
        expect(api.forEachOffer).not.toHaveBeenCalled();
    });

    it("stops an active REST producer before publishing late work after purge", async () => {
        const api = {
            async forEachListing(
                _slug: string,
                _contract: string,
                handler: (record: {
                    eventType: string;
                    orderId: string;
                    sourceEventAt: number | null;
                    payload: Record<string, unknown>;
                }) => Promise<void>,
            ) {
                db.prepare(
                    "DELETE FROM collections WHERE collection_id=99",
                ).run();
                await handler({
                    eventType: "fixture",
                    orderId: "late",
                    sourceEventAt: NOW,
                    payload: {},
                });
            },
            forEachOffer: vi.fn(),
        };
        const publish = vi.fn();
        const sync = new OpenSeaOrderbookSync(
            api,
            { publish },
            new SqliteOrderSourceStateStore(),
        );
        const collection = new SqliteCollectionRegistry().getCollection(1, 99)!;
        expect(
            await sync.syncCollection(
                collection,
                OFFCHAIN_OBSERVATION_CHANNEL.Snapshot,
                1,
            ),
        ).toEqual({ activeOrders: 0, deactivatedOrders: 0 });
        expect(publish).not.toHaveBeenCalled();
        expect(api.forEachOffer).not.toHaveBeenCalled();
        expect(tempTables()).toEqual([]);
    });
});
