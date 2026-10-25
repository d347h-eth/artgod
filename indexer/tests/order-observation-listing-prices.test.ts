import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import {
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_KIND,
    ACTIVITY_SOURCE_KIND,
} from "@artgod/shared/types";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import {
    ORDER_SOURCE_STATUS,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
} from "../src/domain/orders.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import {
    HEAVY_MAKER as H,
    heavyMakerOrder,
    HeavyMakerRpc,
} from "./fixtures/heavy-maker.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

// Synthetic order terms, accepted bootstrap base and controlled RPC; migrated
// SQLite plus actual admission, proof completion, ask and daily-price owners.
describe("daily listing prices after source observations", () => {
    loadTestEnv();
    let clock: number;
    let orders: SqliteOrdersDomain, demand: SqliteOrderValidationDemand;
    let owner: ReturnType<typeof createAppliedSyncFixture>,
        processor: ValidateOrderDemand;
    const anchor = { ...syncBlockFixture(900), timestamp: H.now };
    const contract = heavyMakerOrder(0).contract;
    function declaration(index: number): OrderUpsertPayload {
        const record = heavyMakerOrder(index, {
            maker: H.smallMaker,
            side: ORDER_SIDE.Sell,
            tokenId: "7",
        });
        return {
            ...record,
            orderId: record.id,
            quantity: "1",
            observedAt: clock,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        };
    }
    function sample() {
        owner.progress.recordHeadSample(
            owner.progress.captureHeadSample(1),
            anchor,
            clock * 1000,
        );
    }
    function snapshot(id: string) {
        return {
            ask: new SqliteCurrentAsks(db.raw, [H.weth]).forSeller(
                1,
                9,
                "7",
                H.smallMaker,
                clock,
            ),
            daily: db
                .prepare(
                    "SELECT order_id,price,amount,listing_price_at FROM activities",
                )
                .get(),
            order: db
                .prepare(
                    "SELECT state_revision,quantity,proof_order_revision FROM orders WHERE id=?",
                )
                .get(id),
            demand: demand.get(1, id),
        };
    }
    beforeEach(async () => {
        clock = H.now;
        vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);
        for (const level of ["info", "warn", "error", "debug"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(chain_id,collection_id,slug,opensea_slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES(1,9,'additional-source','additional-source',?,'erc721','live','contract_all_tokens',900)",
        ).run(contract);
        db.prepare(
            "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id) VALUES(1,9,?,'7')",
        ).run(contract);
        orders = new SqliteOrdersDomain(H.weth, undefined, () => clock);
        demand = new SqliteOrderValidationDemand(orders);
        owner = createAppliedSyncFixture({
            chainId: 1,
            anchor,
            collections: [new SqliteCollectionRegistry().getCollection(1, 9)!],
        });
        const rpc = new HeavyMakerRpc();
        rpc.getBlock = async (n) => {
            if (n !== 900) throw new Error(`unexpected block ${n}`);
            return anchor;
        };
        processor = new ValidateOrderDemand({
            chainId: 1,
            store: demand,
            createSnapshot: createSeaportOrderValidationFactory({
                chainId: 1,
                rpc,
                conduitController: H.controller,
                now: () => clock * 1000,
            }),
            admission: new FairOrderValidationAdmission(2),
            now: () => clock * 1000,
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });
    it.each([
        "quantity-observation",
        "additional-source",
        "lifecycle-control",
        "rest-after-lifecycle",
    ])(
        "uses the eligible ask after %s and restores the cheaper ask after validation",
        async (mode) => {
            const cheap = declaration(0),
                dear = declaration(1);
            await orders.handleOrderUpsert(cheap);
            await orders.handleOrderUpsert(dear);
            sample();
            expect(await processor.executeBatch()).toMatchObject({
                applied: 2,
            });
            await new SqliteActivityDomain(
                [H.weth],
                () => clock,
            ).handleActivityUpsert({
                chainId: 1,
                collectionId: 9,
                contract,
                tokenId: "7",
                maker: H.smallMaker,
                scopeKind: ACTIVITY_SCOPE_KIND.Token,
                kind: ACTIVITY_KIND.ListingCreated,
                sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
                sourceName: OFFCHAIN_ORDER_SOURCE.OpenSea,
                sourceEventKey: cheap.orderId,
                orderId: cheap.orderId,
                occurredAt: clock,
                side: ORDER_SIDE.Sell,
                price: cheap.price!,
                currency: H.weth,
            });
            const before = snapshot(cheap.orderId);
            expect(before.ask?.id).toBe(cheap.orderId);
            expect(before.daily).toMatchObject({
                order_id: cheap.orderId,
                price: cheap.price,
            });
            clock++;
            await orders.handleOrderUpsert({ ...cheap, observedAt: clock });
            const duplicate = snapshot(cheap.orderId);
            expect(duplicate.demand).toEqual(before.demand);
            expect(duplicate.order).toEqual(before.order);
            expect(duplicate.ask?.id).toBe(cheap.orderId);
            expect(duplicate.daily).toMatchObject({
                order_id: cheap.orderId,
                price: cheap.price,
            });
            if (mode === "rest-after-lifecycle") {
                clock++;
                await orders.handleOrderUpdateById({
                    chainId: 1,
                    collectionId: 9,
                    orderId: cheap.orderId,
                    source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                    sourceStatus: ORDER_SOURCE_STATUS.Active,
                    reason: ORDER_UPDATE_REASON.Validation,
                    observedAt: clock,
                });
                sample();
                expect(await processor.executeBatch()).toMatchObject({
                    applied: 1,
                });
            }
            const beforeTrigger = snapshot(cheap.orderId);
            expect(beforeTrigger.ask?.id).toBe(cheap.orderId);
            expect(beforeTrigger.demand?.pending).toBe(false);
            clock++;
            if (mode === "lifecycle-control") {
                await orders.handleOrderUpdateById({
                    chainId: 1,
                    collectionId: 9,
                    orderId: cheap.orderId,
                    source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                    sourceStatus: ORDER_SOURCE_STATUS.Active,
                    reason: ORDER_UPDATE_REASON.Validation,
                    observedAt: clock,
                });
            } else {
                await orders.handleOrderUpsert({
                    ...cheap,
                    observedAt: clock,
                    ...(mode === "quantity-observation"
                        ? { quantity: "2" }
                        : mode === "additional-source"
                          ? { source: "additional-source" }
                          : {}),
                });
            }
            const changed = snapshot(cheap.orderId);
            expect(changed.order).toEqual(before.order);
            expect(changed.demand).toMatchObject({
                pending: true,
                generation: beforeTrigger.demand!.generation + 1,
            });
            expect(changed.ask?.id).toBe(dear.orderId);
            // The activity row and current ask must agree at the same committed state,
            // without waiting for periodic price maintenance or a new validation.
            expect(changed.daily).toMatchObject({
                order_id: dear.orderId,
                price: dear.price,
                listing_price_at: clock,
            });
            expect(await processor.executeBatch()).toBeUndefined();
            sample();
            expect(await processor.executeBatch()).toMatchObject({
                applied: 1,
            });
            const revalidated = snapshot(cheap.orderId);
            expect(revalidated.ask?.id).toBe(cheap.orderId);
            expect(revalidated.daily).toMatchObject({
                order_id: cheap.orderId,
                price: cheap.price,
            });
        },
    );
});
