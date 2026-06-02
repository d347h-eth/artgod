import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { MAKER_TRIGGER_SCOPE } from "../src/domain/order-jobs.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import {
    ORDER_STATUS,
    type OrderRecord,
    type OrderStatus,
} from "../src/domain/orders.js";
import type { OrderUpsertPayload } from "../src/domain/order-jobs.js";
import { normalizeOffchainOrder } from "../src/application/offchain/normalize.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { ORDER_UPDATE_BY_MAKER_LOG_MESSAGE } from "../src/infra/domain/order-update-by-maker-reporting.js";
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
        db.exec(["DELETE FROM orders;", "DELETE FROM collections;"].join("\n"));
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
            scope: MAKER_TRIGGER_SCOPE.Token,
            collectionId: order.collectionId,
            maker: order.maker,
            contract: order.contract,
            tokenId: order.tokenId ?? "0",
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
            blockNumber: 1,
            blockHash: "0x1",
            txHash: "0x2",
            logIndex: 0,
        });

        expect(getFillabilityStatus(order.orderId)).toBe(ORDER_STATUS.Fillable);
        expect(validatedOrderIds).toEqual([order.orderId]);
    });

    it("scopes nft-transfer revalidation by collectionId for sibling collections on one contract", async () => {
        const chainId = 1;
        const fixture = await readFixture("item_listed.json");
        const order = await insertOrderFromFixture(chainId, fixture);
        const siblingOrder = await insertOrderFromFixture(chainId, fixture, {
            collectionId: 2,
            orderId:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });

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
            scope: MAKER_TRIGGER_SCOPE.Token,
            collectionId: order.collectionId,
            maker: order.maker,
            tokenId: order.tokenId ?? "0",
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
            blockNumber: 1,
            blockHash: "0x1",
            txHash: "0x2",
            logIndex: 0,
        });

        expect(getFillabilityStatus(order.orderId)).toBe(ORDER_STATUS.Fillable);
        expect(getFillabilityStatus(siblingOrder.orderId)).toBe(
            ORDER_STATUS.Fillable,
        );
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
            scope: MAKER_TRIGGER_SCOPE.Global,
            maker: buyOrder.maker,
            reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
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

    it("logs maker revalidation as one compact aggregate report", async () => {
        const chainId = 1;
        const fixture = await readFixture("item_received_bid.json");
        const firstOrder = await insertOrderFromFixture(chainId, fixture, {
            orderId:
                "0x1111111111111111111111111111111111111111111111111111111111111111",
            currency: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        });
        const secondOrder = await insertOrderFromFixture(chainId, fixture, {
            orderId:
                "0x2222222222222222222222222222222222222222222222222222222222222222",
            maker: firstOrder.maker,
            currency: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (candidate) => {
                if (candidate.id === firstOrder.orderId) {
                    return {
                        status: ORDER_STATUS.Fillable,
                        reason: "still-fillable",
                    };
                }
                return {
                    status: ORDER_STATUS.NoBalance,
                    reason: "balance-dropped",
                };
            },
        );
        let logs: Array<{ msg?: string; [key: string]: unknown }> = [];

        try {
            await domain.handleOrderUpdateByMaker(
                {
                    chainId,
                    scope: MAKER_TRIGGER_SCOPE.Global,
                    maker: firstOrder.maker,
                    reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                    blockNumber: 1,
                    blockHash: "0x1",
                    txHash: "0x2",
                    logIndex: 0,
                },
                {
                    jobId: "orders:update:maker:test",
                    attempt: 2,
                    scheduledAt: 123,
                    traceId: "trace-test",
                    consumerName: "orders-update-by-maker-1",
                },
            );
            const logCalls = logSpy.mock.calls as Array<
                [unknown, ...unknown[]]
            >;
            logs = logCalls.map(
                (call) =>
                    JSON.parse(String(call[0])) as {
                        msg?: string;
                        [key: string]: unknown;
                    },
            );
        } finally {
            logSpy.mockRestore();
        }

        expect(
            logs.some(
                (entry) =>
                    entry.msg ===
                    ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.LegacyValidationResult,
            ),
        ).toBe(false);

        const started = logs.find(
            (entry) =>
                entry.msg === ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.Started,
        );
        expect(started).toMatchObject({
            jobId: "orders:update:maker:test",
            attempt: 2,
            traceId: "trace-test",
            maker: firstOrder.maker.toLowerCase(),
            candidateOrders: 2,
            currentStateCandidateOrders: 2,
        });

        const completed = logs.find(
            (entry) =>
                entry.msg === ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.Completed,
        );
        expect(completed).toMatchObject({
            jobId: "orders:update:maker:test",
            validatedOrders: 2,
            updated: 2,
        });
        const validation = completed?.validation as {
            statuses: Record<string, number>;
            reasons: Record<string, number>;
            slowest: unknown[];
        };
        expect(validation.statuses).toMatchObject({
            [ORDER_STATUS.Fillable]: 1,
            [ORDER_STATUS.NoBalance]: 1,
        });
        expect(validation.reasons).toMatchObject({
            "still-fillable": 1,
            "balance-dropped": 1,
        });
        expect(validation.slowest).toHaveLength(2);
        expect(getFillabilityStatus(secondOrder.orderId)).toBe(
            ORDER_STATUS.NoBalance,
        );
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
            scope: MAKER_TRIGGER_SCOPE.Global,
            maker: order.maker,
            reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
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

    it("ignores maker triggers before the collection bootstrap anchor", async () => {
        const chainId = 1;
        const fixture = await readFixture("item_received_bid.json");
        const order = await insertOrderFromFixture(chainId, fixture);
        setCollectionAnchor(chainId, order.collectionId, 100);

        const validatedOrderIds: string[] = [];
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async (candidate) => {
                validatedOrderIds.push(candidate.id);
                return {
                    status: ORDER_STATUS.Cancelled,
                    reason: "should-not-run-before-anchor",
                };
            },
        );

        await domain.handleOrderUpdateByMaker({
            chainId,
            scope: MAKER_TRIGGER_SCOPE.Global,
            maker: order.maker,
            reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            blockNumber: 99,
            blockHash: "0x1",
            txHash: "0x2",
            logIndex: 0,
        });

        expect(getFillabilityStatus(order.orderId)).toBe(ORDER_STATUS.Fillable);
        expect(validatedOrderIds).toEqual([]);
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
    ensureCollection(chainId, payload.collectionId, payload.contract);

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

function ensureCollection(
    chainId: number,
    collectionId: number,
    contract: string,
): void {
    db.prepare<[number, number, string, string]>(
        "INSERT OR REPLACE INTO collections " +
            "(chain_id, collection_id, slug, address, standard, status, token_scope_kind, bootstrap_anchor_block) " +
            "VALUES (?, ?, ?, ?, 'erc721', 'live', 'contract_all_tokens', 0)",
    ).run(
        chainId,
        collectionId,
        `collection-${collectionId}`,
        contract.toLowerCase(),
    );
}

function setCollectionAnchor(
    chainId: number,
    collectionId: number,
    anchorBlock: number,
): void {
    db.prepare<[number, number, number]>(
        "UPDATE collections SET bootstrap_anchor_block = ? WHERE chain_id = ? AND collection_id = ?",
    ).run(anchorBlock, chainId, collectionId);
}
