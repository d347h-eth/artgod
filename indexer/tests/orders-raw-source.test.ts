import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_STATUS,
    type OrderRecord,
    type SeaportOrderData,
} from "../src/domain/orders.js";
import type {
    OrderUpsertPayload,
    OrderUpdateByIdPayload,
} from "../src/domain/order-jobs.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("orders raw source selection", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec("DELETE FROM orders;");
    });

    it("validates using canonical seaport data rather than audit payload fields", async () => {
        let validatedOrder: OrderRecord | null = null;
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (order) => {
                validatedOrder = order;
                return {
                    status: ORDER_STATUS.Fillable,
                    reason: "validated-canonical-seaport-data",
                };
            },
        );

        await domain.handleOrderUpsert(
            buildOrderUpsert("rest", {
                source: "rest",
            }),
        );
        await domain.handleOrderUpsert(
            buildOrderUpsert("stream", {
                source: "stream",
            }),
        );

        await domain.handleOrderUpdateById(buildOrderUpdate());

        expect(validatedOrder).not.toBeNull();
        if (!validatedOrder) return;
        expect(validatedOrder.seaportData).toEqual(buildSeaportData());
    });

    it("preserves a stream signature when a later REST upsert refreshes the same order", async () => {
        let validatedOrder: OrderRecord | null = null;
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (order) => {
                validatedOrder = order;
                return {
                    status: ORDER_STATUS.Fillable,
                    reason: "validated-canonical-seaport-data",
                };
            },
        );

        await domain.handleOrderUpsert(
            buildOrderUpsert(
                "stream",
                { source: "stream" },
                {
                    signature:
                        "0x4a02955b3d1b3f24610cc2f3fe742c19e284a7e10abf5777ecb74601556130f7011cdf9b1c1f637a9e93692d2f38bf4d76f3afa6d0e0f8d4b7201e2440d096001c",
                },
            ),
        );
        await domain.handleOrderUpsert(
            buildOrderUpsert(
                "rest",
                { source: "rest" },
                {
                    signature: null,
                },
            ),
        );

        await domain.handleOrderUpdateById(buildOrderUpdate());

        expect(validatedOrder).not.toBeNull();
        if (!validatedOrder) return;
        expect(validatedOrder.seaportData?.signature).toBe(
            "0x4a02955b3d1b3f24610cc2f3fe742c19e284a7e10abf5777ecb74601556130f7011cdf9b1c1f637a9e93692d2f38bf4d76f3afa6d0e0f8d4b7201e2440d096001c",
        );
        expect(validatedOrder.seaportDataSourceKind).toBe(
            ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
        );
    });
});

function buildOrderUpsert(
    rawSourceKind: "rest" | "stream",
    rawPayload: Record<string, unknown>,
    seaportOverrides: Partial<SeaportOrderData> = {},
): OrderUpsertPayload {
    return {
        chainId: 1,
        orderId:
            "0xca2f030878888d975a62f94f5abcceda4b7b075e836eb112d1b9008ac0d22eaa",
        kind: "seaport",
        side: "buy",
        maker: "0xc19dc40f81aa9bfeda63f26ccd33aa465e7aa61a",
        taker: null,
        contract: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        tokenId: "5788",
        sourceScopeKind: "token",
        sourceCriteriaRoot: null,
        sourceSchema: null,
        localTokenSetStatus: "none",
        tokenSetId: null,
        tokenSetSchemaHash: null,
        price: "3310000000000000000",
        currency: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        validFrom: 1700000000,
        validUntil: 1800000000,
        seaportData: buildSeaportData(seaportOverrides),
        source: "opensea",
        sourceStatus: "active",
        rawSourceKind,
        rawPayload,
        validateAfterUpsert: false,
    };
}

function buildSeaportData(
    overrides: Partial<SeaportOrderData> = {},
): SeaportOrderData {
    return {
        protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
        signature: overrides.signature ?? null,
        offerer: "0xc19dc40f81aa9bfeda63f26ccd33aa465e7aa61a",
        zone: "0x0000000000000000000000000000000000000000",
        offer: [
            {
                itemType: "1",
                token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                identifierOrCriteria: "0",
                startAmount: "3310000000000000000",
                endAmount: "3310000000000000000",
            },
        ],
        consideration: [
            {
                itemType: "2",
                token: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
                identifierOrCriteria: "5788",
                startAmount: "1",
                endAmount: "1",
                recipient: "0xc19dc40f81aa9bfeda63f26ccd33aa465e7aa61a",
            },
        ],
        orderType: "0",
        startTime: "1700000000",
        endTime: "1800000000",
        zoneHash:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        salt: "1",
        conduitKey:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        totalOriginalConsiderationItems: "1",
        counter: "0",
        ...overrides,
    };
}

function buildOrderUpdate(): OrderUpdateByIdPayload {
    return {
        chainId: 1,
        orderId:
            "0xca2f030878888d975a62f94f5abcceda4b7b075e836eb112d1b9008ac0d22eaa",
        reason: "order",
        sourceStatus: null,
        blockNumber: 1,
        blockHash: "0x1",
        txHash: "0x2",
        logIndex: 0,
    };
}
