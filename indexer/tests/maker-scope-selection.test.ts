import { persistCanonicalBlocks } from "../src/infra/storage/sqlite-canonical-headers.js";
import { captureChainSyncCheckpoint } from "../src/infra/storage/sqlite-chain-revisions.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import {
    MAKER_TRIGGER_SCOPE,
    GLOBAL_MAKER_TRIGGER_REASON,
    COLLECTION_SCOPED_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import {
    ORDER_SIDE,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
} from "../src/domain/orders.js";
import type { OrderUpdateByMakerPayload } from "../src/domain/order-jobs.js";
import {
    HEAVY_MAKER,
    heavyMakerHint,
    heavyMakerBlock,
    heavyMakerOrder,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1000;
describe("maker invalidation scope selection", () => {
    loadTestEnv();
    let orders: SqliteOrdersDomain;
    let demand: SqliteOrderValidationDemand;
    let store: SqliteMakerRevalidations;
    let ordinal = 0;
    beforeEach(async () => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(0);
        db.writeTransaction(() =>
            persistCanonicalBlocks(
                captureChainSyncCheckpoint(1),
                [heavyMakerBlock()],
                () => false,
            ),
        )();
        db.exec("DELETE FROM orders");
        orders = new SqliteOrdersDomain(HEAVY_MAKER.weth);
        demand = new SqliteOrderValidationDemand(orders);
        store = new SqliteMakerRevalidations(orders, demand, HEAVY_MAKER.weth);
        ordinal = 0;
    });
    afterEach(() => vi.restoreAllMocks());
    function add(overrides: Partial<OrderRecord> = {}) {
        const order = heavyMakerOrder(ordinal++, overrides);
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,side,source,maker,contract_address,token_id,price,currency,valid_until,fillability_status,source_status,seaport_data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
            order.id,
            order.chainId,
            order.collectionId,
            order.kind,
            order.side,
            order.source,
            order.maker,
            order.contract,
            order.tokenId,
            order.price,
            order.currency,
            order.validUntil,
            order.fillabilityStatus,
            order.sourceStatus,
            order.seaportData ? JSON.stringify(order.seaportData) : null,
        );
        return order;
    }
    function expand(payload: OrderUpdateByMakerPayload) {
        const run = store.admit({ payload, jobId: "fixture-scope", now });
        if (run) store.expand(store.claim(run.runId, "fixture", now)!, now);
        return (
            db
                .prepare(
                    "SELECT order_id FROM order_validation_demand WHERE pending=1 ORDER BY order_id",
                )
                .all() as { order_id: string }[]
        ).map((row) => row.order_id);
    }
    it.each([
        GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
        GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange,
    ])(
        "selects only active actionable WETH buys for %s, including incomplete declarations",
        (reason) => {
            const expected = [
                ORDER_STATUS.Unvalidated,
                ORDER_STATUS.Fillable,
                ORDER_STATUS.NoBalance,
                ORDER_STATUS.NoApproval,
            ].map((fillabilityStatus) => add({ fillabilityStatus }));
            expected.push(add({ seaportData: null }));
            add({ currency: "0x9999999999999999999999999999999999999999" });
            add({ side: ORDER_SIDE.Sell });
            add({ kind: "fixture-other-protocol" });
            add({ maker: HEAVY_MAKER.smallMaker });
            add({ validUntil: HEAVY_MAKER.now });
            for (const sourceStatus of [
                ORDER_SOURCE_STATUS.Inactive,
                ORDER_SOURCE_STATUS.Cancelled,
                ORDER_SOURCE_STATUS.Filled,
            ])
                add({ sourceStatus });
            for (const fillabilityStatus of [
                ORDER_STATUS.Cancelled,
                ORDER_STATUS.Filled,
                ORDER_STATUS.Invalid,
                ORDER_STATUS.Expired,
            ])
                add({ fillabilityStatus });
            expect(expand({ ...heavyMakerHint(), reason })).toEqual(
                expected.map((order) => order.id).sort(),
            );
        },
    );
    it("retains exact-token sell obligations only in the selected collection", () => {
        const selected = add({ side: ORDER_SIDE.Sell, tokenId: "7" });
        add({ side: ORDER_SIDE.Sell, tokenId: "8" });
        add({ side: ORDER_SIDE.Sell, tokenId: "7", collectionId: 11 });
        add({ side: ORDER_SIDE.Buy, tokenId: "7" });
        expect(
            expand({
                ...heavyMakerHint(),
                scope: MAKER_TRIGGER_SCOPE.Token,
                reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
                collectionId: 9,
                tokenId: "7",
            }),
        ).toEqual([selected.id]);
    });
    it("retains collection-wide approval obligations across tokens without selecting sibling scopes", () => {
        const selected = ["7", "8"].map((tokenId) =>
            add({ side: ORDER_SIDE.Sell, tokenId }),
        );
        add({ side: ORDER_SIDE.Sell, collectionId: 11 });
        add({ side: ORDER_SIDE.Buy });
        expect(
            expand({
                ...heavyMakerHint(),
                scope: MAKER_TRIGGER_SCOPE.Collection,
                reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
                collectionId: 9,
            }),
        ).toEqual(selected.map((order) => order.id).sort());
    });
    it("invalidates all actionable Seaport sides and currencies for a maker counter change", () => {
        const selected = [
            add(),
            add({ currency: "0x9999999999999999999999999999999999999999" }),
            add({ side: ORDER_SIDE.Sell }),
        ];
        add({ maker: HEAVY_MAKER.smallMaker });
        add({ kind: "fixture-other-protocol" });
        expect(
            expand({
                ...heavyMakerHint(),
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            }),
        ).toEqual(selected.map((order) => order.id).sort());
    });
    it("accounts for pre-anchor canonical triggers without admitting obsolete validation", () => {
        add();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=9",
        ).run(HEAVY_MAKER.blockNumber);
        expect(expand(heavyMakerHint())).toEqual([]);
    });
});
