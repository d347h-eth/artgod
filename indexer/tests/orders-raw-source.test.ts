import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { statSync } from "node:fs";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
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
        db.exec(["DELETE FROM orders;", "DELETE FROM collections;"].join("\n"));
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
        ensureCollection(1, 1, "0x5af0d9827e0c53e4799bb226655a1de152a425a5");

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

    it("does no SQLite or WAL writes for a burst of unchanged, recently validated observations", async () => {
        let now = 1_790_000_000;
        const domain = new SqliteOrdersDomain(
            "0xweth",
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
        const payload = buildOrderUpsert("rest", {});
        ensureCollection(1, 1, payload.contract);
        await domain.handleOrderUpsert({ ...payload, observedAt: now });
        await domain.handleOrderUpdateById({
            ...buildOrderUpdate(),
            blockNumber: null,
        });
        db.raw.pragma("wal_checkpoint(TRUNCATE)");
        const before = db.prepare("SELECT total_changes() AS n").get();
        for (let i = 0; i < 1_000; i++) {
            expect(
                await domain.handleOrderUpsert({ ...payload, observedAt: now }),
            ).toMatchObject({ changed: false, validationNeeded: false });
        }
        expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
        expect(statSync(`${db.raw.name}-wal`).size).toBe(0);
        now += POLICY.orderRevalidationSeconds;
        expect(
            await domain.handleOrderUpsert({ ...payload, observedAt: now }),
        ).toMatchObject({ changed: false, validationNeeded: true });
        expect(db.prepare("SELECT observed_at FROM orders").get()).toEqual({
            observed_at: now,
        });
    });

    it("keeps validation required on retry after canonical enrichment commits without its validation job", async () => {
        const now = 1_790_000_000;
        const domain = new SqliteOrdersDomain(
            "0xweth",
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
        const rest = { ...buildOrderUpsert("rest", {}), observedAt: now };
        ensureCollection(1, 1, rest.contract);
        await domain.handleOrderUpsert(rest);
        await domain.handleOrderUpdateById({
            ...buildOrderUpdate(),
            blockNumber: null,
        });
        const enriched = {
            ...buildOrderUpsert("stream", {}, { signature: "0x1234" }),
            observedAt: now,
            validateAfterUpsert: true,
        };
        const committed = await domain.handleOrderUpsert(enriched);
        expect(committed).toMatchObject({
            changed: true,
            validationNeeded: true,
        });
        // Publishing failed after commit: retry the same queue payload without validation.
        expect(await domain.handleOrderUpsert(enriched)).toEqual({
            changed: false,
            validationNeeded: true,
            validationRevision: committed.validationRevision,
        });
        await domain.handleOrderUpdateById({
            ...buildOrderUpdate(),
            blockNumber: null,
        });
        expect(await domain.handleOrderUpsert(enriched)).toEqual({
            changed: false,
            validationNeeded: false,
            validationRevision: committed.validationRevision,
        });
    });

    it("fences a cancellation received before create, including duplicate cancellation and delayed REST", async () => {
        const now = 1_790_000_000;
        const domain = new SqliteOrdersDomain(
            "0xweth",
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
        const payload = buildOrderUpsert("stream", {});
        ensureCollection(1, 1, payload.contract);
        const cancel = {
            chainId: 1,
            collectionId: 1,
            orderId: payload.orderId,
            reason: "cancel",
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            observedAt: now - 1,
        };
        await domain.handleOrderUpdateById(cancel);
        await domain.handleOrderUpdateById(cancel);
        expect(
            await domain.handleOrderUpsert({ ...payload, observedAt: now }),
        ).toMatchObject({ changed: false, validationNeeded: false });
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 0,
        });
        expect(
            db.prepare("SELECT expires_at FROM market_order_retirements").get(),
        ).toEqual({
            expires_at: payload.validUntil! + POLICY.orderReorgGraceSeconds,
        });
    });

    it("applies a two-day-delayed cancellation to a known unexpired order", async () => {
        const now = 1_790_000_000;
        const domain = new SqliteOrdersDomain(
            "0xweth",
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
        const payload = buildOrderUpsert("rest", {});
        ensureCollection(1, 1, payload.contract);
        await domain.handleOrderUpsert({ ...payload, observedAt: now });
        await domain.handleOrderUpdateById({
            chainId: 1,
            collectionId: 1,
            orderId: payload.orderId,
            reason: "cancel",
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            observedAt: now - 2 * POLICY.utcDaySeconds,
        });
        expect(db.prepare("SELECT source_status FROM orders").get()).toEqual({
            source_status: ORDER_SOURCE_STATUS.Cancelled,
        });
        expect(
            await domain.handleOrderUpsert({ ...payload, observedAt: now }),
        ).toMatchObject({ changed: false });
    });

    it("rejects an old queued create after its unknown-order cancellation record expires", async () => {
        let now = 1_790_000_000;
        const first = now;
        const domain = new SqliteOrdersDomain(
            "0xweth",
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
        const payload = buildOrderUpsert("stream", {});
        ensureCollection(1, 1, payload.contract);
        await domain.handleOrderUpdateById({
            chainId: 1,
            collectionId: 1,
            orderId: payload.orderId,
            reason: "cancel",
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            observedAt: first,
        });
        now += POLICY.unknownOrderLifetimeSeconds + 1;
        expect(
            await domain.handleOrderUpsert({
                ...payload,
                observedAt: first - 1,
            }),
        ).toMatchObject({ changed: false });
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 0,
        });
    });

    it("rejects expired or stale queued input but admits fresh observations of valid orders", async () => {
        const now = 1_790_000_000;
        const domain = new SqliteOrdersDomain(
            "0xweth",
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
        const payload = buildOrderUpsert("stream", {});
        ensureCollection(1, 1, payload.contract);
        for (const input of [
            { ...payload, validUntil: now },
            {
                ...payload,
                validUntil: null,
                observedAt: now - POLICY.unknownOrderLifetimeSeconds,
            },
        ]) {
            expect(await domain.handleOrderUpsert(input)).toMatchObject({
                changed: false,
                validationNeeded: false,
            });
        }
        expect(
            await domain.handleOrderUpsert({
                ...payload,
                observedAt: now - 30 * POLICY.utcDaySeconds,
            }),
        ).toMatchObject({ changed: false, validationNeeded: false });
        expect(
            await domain.handleOrderUpsert({ ...payload, observedAt: now }),
        ).toMatchObject({ changed: true });
        db.raw.exec("DELETE FROM orders; DELETE FROM collections");
        expect(await domain.handleOrderUpsert(payload)).toMatchObject({
            changed: false,
            validationNeeded: false,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 0,
        });
    });

    it("does not apply an awaited validation over a newer cancellation", async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const domain = new SqliteOrdersDomain("0xweth", async () => {
            await pending;
            return { status: ORDER_STATUS.Fillable, reason: "fixture" };
        });
        const payload = buildOrderUpsert("rest", {});
        ensureCollection(1, 1, payload.contract);
        await domain.handleOrderUpsert(payload);
        const validation = domain.handleOrderUpdateById({
            ...buildOrderUpdate(),
            blockNumber: null,
        });
        await domain.handleOrderUpdateById({
            ...buildOrderUpdate(),
            reason: "cancel",
            blockNumber: null,
        });
        finish();
        await validation;
        expect(getFillabilityStatus(payload.orderId)).toBe(
            ORDER_STATUS.Cancelled,
        );
    });

    it("omits raw order audit payloads by default", async () => {
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async () => ({
                status: ORDER_STATUS.Fillable,
                reason: "unused",
            }),
        );
        const payload = buildOrderUpsert("rest", {
            source: "rest",
            debugPayload: "large-source-record",
        });
        ensureCollection(
            payload.chainId,
            payload.collectionId,
            payload.contract,
        );

        await domain.handleOrderUpsert(payload);

        expect(selectRawOrderPayloads(payload.orderId)).toEqual({
            raw_rest_data: null,
            raw_stream_data: null,
        });
    });

    it("stores raw order audit payloads when raw debug payload persistence is enabled", async () => {
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async () => ({
                status: ORDER_STATUS.Fillable,
                reason: "unused",
            }),
            { persistRawDebugPayloads: true },
        );
        const rawPayload = {
            source: "stream",
            debugPayload: "large-source-record",
        };
        const payload = buildOrderUpsert("stream", rawPayload);
        ensureCollection(
            payload.chainId,
            payload.collectionId,
            payload.contract,
        );

        await domain.handleOrderUpsert(payload);

        expect(selectRawOrderPayloads(payload.orderId)).toEqual({
            raw_rest_data: null,
            raw_stream_data: JSON.stringify(rawPayload),
        });
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
        ensureCollection(1, 1, "0x5af0d9827e0c53e4799bb226655a1de152a425a5");

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

    it("ignores onchain order updates before the collection bootstrap anchor", async () => {
        const domain = new SqliteOrdersDomain(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            async () => ({
                status: ORDER_STATUS.Cancelled,
                reason: "should-not-run-before-anchor",
            }),
        );
        const payload = buildOrderUpsert("stream", {
            source: "stream",
        });
        ensureCollection(
            payload.chainId,
            payload.collectionId,
            payload.contract,
        );
        setCollectionAnchor(payload.chainId, payload.collectionId, 100);

        await domain.handleOrderUpsert(payload);
        await domain.handleOrderUpdateById({
            ...buildOrderUpdate(),
            reason: "cancel",
            blockNumber: 99,
        });

        expect(getFillabilityStatus(payload.orderId)).toBe(
            ORDER_STATUS.Fillable,
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
        collectionId: 1,
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

function getFillabilityStatus(orderId: string): string | null {
    const row = db
        .prepare<[string]>("SELECT fillability_status FROM orders WHERE id = ?")
        .get(orderId) as { fillability_status: string } | undefined;
    return row?.fillability_status ?? null;
}

function selectRawOrderPayloads(orderId: string): {
    raw_rest_data: string | null;
    raw_stream_data: string | null;
} {
    const row = db
        .prepare<
            [string],
            { raw_rest_data: string | null; raw_stream_data: string | null }
        >("SELECT raw_rest_data, raw_stream_data " + "FROM orders WHERE id = ?")
        .get(orderId);
    expect(row).toBeDefined();
    return row!;
}
