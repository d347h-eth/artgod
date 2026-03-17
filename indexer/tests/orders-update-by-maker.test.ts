import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import type { OrderUpsertPayload } from "../src/domain/order-jobs.js";
import {
    ORDER_STATUS,
    type OrderRecord,
    type OrderStatus,
} from "../src/domain/orders.js";
import { normalizeOffchainOrder } from "../src/application/offchain/normalize.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import type { OffchainOrderRawPayload } from "../src/domain/offchain-jobs.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

type FixtureEnvelope = {
    eventType: string;
    payload: Record<string, unknown>;
};

describe("orders update by maker", () => {
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

    it("revalidates exact-token sell orders for nft-transfer instead of blindly invalidating", async () => {
        const chainId = 1;
        const fixture = await readFixture("item_listed.json");
        const order = await insertOrderFromFixture(chainId, fixture);
        const validatedOrderIds: string[] = [];
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (candidate) => {
                validatedOrderIds.push(candidate.id);
                return {
                    status: ORDER_STATUS.Fillable,
                    reason: "owner-and-approval-still-valid",
                };
            },
        );

        await domain.handleOrderUpdateByMaker({
            chainId,
            maker: order.maker,
            contract: order.contract,
            tokenId: order.tokenId ?? undefined,
            reason: "nft-transfer",
            blockNumber: 1,
            blockHash: "0x1",
            txHash: "0x2",
            logIndex: 0,
        });

        expect(getFillabilityStatus(order.orderId)).toBe(ORDER_STATUS.Fillable);
        expect(validatedOrderIds).toEqual([order.orderId]);
    });

    it("revalidates only WETH buy orders for erc20-balance triggers", async () => {
        const chainId = 1;
        const buyFixture = await readFixture("item_received_bid.json");
        const buyOrder = await insertOrderFromFixture(chainId, buyFixture, {
            currency: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        });

        const sellFixture = await readFixture("item_listed.json");
        const sellOrder = await insertOrderFromFixture(chainId, sellFixture, {
            orderId:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            maker: buyOrder.maker,
        });

        const validatedOrderIds: string[] = [];
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (candidate) => {
                validatedOrderIds.push(candidate.id);
                if (candidate.id !== buyOrder.orderId) {
                    return {
                        status: ORDER_STATUS.Invalid,
                        reason: "unexpected-order-selection",
                    };
                }
                return {
                    status: ORDER_STATUS.NoBalance,
                    reason: "weth-balance-dropped",
                };
            },
        );

        await domain.handleOrderUpdateByMaker({
            chainId,
            maker: buyOrder.maker,
            reason: "erc20-balance",
            blockNumber: 1,
            blockHash: "0x1",
            txHash: "0x2",
            logIndex: 0,
        });

        expect(getFillabilityStatus(buyOrder.orderId)).toBe(
            ORDER_STATUS.NoBalance,
        );
        expect(getFillabilityStatus(sellOrder.orderId)).toBe(
            ORDER_STATUS.Fillable,
        );
        expect(validatedOrderIds).toEqual([buyOrder.orderId]);
    });

    it("handles broad order-counter triggers by revalidating maker seaport orders", async () => {
        const chainId = 1;
        const fixture = await readFixture("item_received_bid.json");
        const order = await insertOrderFromFixture(chainId, fixture);
        const validatedOrderIds: string[] = [];
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (candidate) => {
                validatedOrderIds.push(candidate.id);
                return {
                    status: ORDER_STATUS.Cancelled,
                    reason: "counter-mismatch",
                };
            },
        );

        await domain.handleOrderUpdateByMaker({
            chainId,
            maker: order.maker,
            reason: "order-counter",
            blockNumber: 1,
            blockHash: "0x1",
            txHash: "0x2",
            logIndex: 0,
        });

        expect(getFillabilityStatus(order.orderId)).toBe(
            ORDER_STATUS.Cancelled,
        );
        expect(validatedOrderIds).toEqual([order.orderId]);
    });
});

async function insertOrderFromFixture(
    chainId: number,
    fixture: FixtureEnvelope,
    overrides: Partial<OrderUpsertPayload> = {},
): Promise<OrderUpsertPayload> {
    const raw: OffchainOrderRawPayload = {
        source: "opensea",
        chainId,
        collectionId: 1,
        receivedAt: Date.now(),
        channel: "stream",
        dedupeKey: `test:${fixture.eventType}:${Date.now()}`,
        eventType: fixture.eventType,
        orderId: null,
        runId: null,
        sourceEventAt: null,
        payload: {
            event_type: fixture.eventType,
            payload: fixture.payload,
        },
    };
    const normalized = normalizeOffchainOrder(raw);
    if (!normalized) {
        throw new Error("Expected fixture to normalize into an order");
    }

    const payload: OrderUpsertPayload = {
        chainId,
        collectionId: overrides.collectionId ?? raw.collectionId,
        orderId: overrides.orderId ?? normalized.orderId,
        kind: overrides.kind ?? normalized.kind,
        side: overrides.side ?? normalized.side,
        maker: overrides.maker ?? normalized.maker,
        taker: overrides.taker ?? normalized.taker ?? null,
        contract: overrides.contract ?? normalized.contract,
        tokenId: overrides.tokenId ?? normalized.tokenId ?? null,
        sourceScopeKind:
            overrides.sourceScopeKind ?? normalized.sourceScopeKind,
        sourceCriteriaRoot:
            overrides.sourceCriteriaRoot ??
            normalized.sourceCriteriaRoot ??
            null,
        sourceSchema: overrides.sourceSchema ?? normalized.sourceSchema ?? null,
        localTokenSetStatus:
            overrides.localTokenSetStatus ??
            normalized.localTokenSetStatus ??
            null,
        tokenSetId: overrides.tokenSetId ?? null,
        tokenSetSchemaHash: overrides.tokenSetSchemaHash ?? null,
        price: overrides.price ?? normalized.price ?? null,
        currency: overrides.currency ?? normalized.currency ?? null,
        validFrom: overrides.validFrom ?? normalized.validFrom ?? null,
        validUntil: overrides.validUntil ?? normalized.validUntil ?? null,
        seaportData: overrides.seaportData ?? normalized.seaportData ?? null,
        source: overrides.source ?? normalized.source,
        sourceStatus: overrides.sourceStatus ?? null,
        rawSourceKind: overrides.rawSourceKind ?? normalized.rawSourceKind,
        rawPayload: overrides.rawPayload ?? normalized.rawPayload,
        validateAfterUpsert: false,
    };

    const domain = new SqliteOrdersDomain(
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        createUnusedValidator(),
    );
    await domain.handleOrderUpsert(payload);
    return payload;
}

async function readFixture(file: string): Promise<FixtureEnvelope> {
    const fixturePath = resolveFixturePath(
        import.meta.url,
        "opensea-event-payloads",
        file,
    );
    const raw = await fs.readFile(fixturePath, "utf8");
    return {
        eventType: path.basename(file, ".json"),
        payload: (JSON.parse(raw) as { payload: Record<string, unknown> })
            .payload,
    };
}

function getFillabilityStatus(orderId: string): string | null {
    const row = db
        .prepare<[string]>("SELECT fillability_status FROM orders WHERE id = ?")
        .get(orderId) as { fillability_status: string } | undefined;
    return row?.fillability_status ?? null;
}

function createUnusedValidator() {
    return async (
        _order: OrderRecord,
    ): Promise<{ status: OrderStatus; reason: string }> => ({
        status: ORDER_STATUS.Fillable,
        reason: "unused-in-upsert-only-test",
    });
}
