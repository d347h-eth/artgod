import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { statSync } from "node:fs";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND as DATA,
    ORDER_STATUS,
} from "../src/domain/orders.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import { observedOrderValidationRequest } from "../src/domain/order-validation-demand.js";
import { installHeavyMakerValidationChain } from "./helpers/heavy-maker-validation-fixture.js";
import {
    HEAVY_MAKER as H,
    heavyMakerOrder,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const order = heavyMakerOrder(0);
const payload = (
    rawSourceKind: typeof DATA.Stream | typeof DATA.Rest = DATA.Rest,
): OrderUpsertPayload => ({
    ...order,
    orderId: order.id,
    source: "opensea",
    sourceScopeKind: order.sourceScopeKind!,
    side: order.side!,
    observedAt: H.now,
    rawSourceKind,
    rawPayload: { price: "debug-only", signature: "debug-only" },
});
describe("normalized declaration and optional raw audit payloads", () => {
    loadTestEnv();
    beforeEach(async () => {
        vi.spyOn(Date, "now").mockReturnValue(H.now * 1000);
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(1);
        db.exec("DELETE FROM orders");
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });
    it("omits raw audit payloads by default", async () => {
        await new SqliteOrdersDomain(H.weth).handleOrderUpsert(payload());
        expect(
            db
                .prepare(
                    "SELECT raw_rest_data,raw_stream_data,seaport_data_json FROM orders",
                )
                .get(),
        ).toEqual({
            raw_rest_data: null,
            raw_stream_data: null,
            seaport_data_json: JSON.stringify(order.seaportData),
        });
    });
    it.each([DATA.Rest, DATA.Stream])(
        "persists opted-in %s debug payload separately from normalized terms",
        async (kind) => {
            await new SqliteOrdersDomain(H.weth, {
                persistRawDebugPayloads: true,
            }).handleOrderUpsert(payload(kind));
            const row = db
                .prepare(
                    "SELECT raw_rest_data,raw_stream_data,seaport_data_json FROM orders",
                )
                .get() as Record<string, string | null>;
            expect(
                JSON.parse(
                    row[
                        kind === DATA.Rest ? "raw_rest_data" : "raw_stream_data"
                    ]!,
                ),
            ).toEqual(payload().rawPayload);
            expect(JSON.parse(row.seaport_data_json!)).toEqual(
                order.seaportData,
            );
        },
    );
    it("returns only normalized canonical terms to a validation claim", async () => {
        const domain = new SqliteOrdersDomain(H.weth, {
            persistRawDebugPayloads: true,
        });
        await domain.handleOrderUpsert(payload());
        const owner = installHeavyMakerValidationChain();
        owner.sample();
        const claim = new SqliteOrderValidationDemand(domain).claimBatch(
            1,
            "fixture",
            Date.now(),
        ).claims[0]!;
        expect(claim.candidate.order.seaportData).toEqual(order.seaportData);
        expect(claim.candidate.order.price).toBe(order.price);
        expect(claim.candidate.order).not.toHaveProperty("rawPayload");
    });
    it("performs no row or WAL writes for equivalent recently admitted retransmissions", async () => {
        const domain = new SqliteOrdersDomain(H.weth);
        await domain.handleOrderUpsert(payload());
        db.raw.pragma("wal_checkpoint(TRUNCATE)");
        const before = db.prepare("SELECT total_changes() AS n").get();
        const wal = statSync(`${db.raw.name}-wal`).size;
        for (let i = 0; i < 30; i++)
            await domain.handleOrderUpsert({
                ...payload(),
                rawPayload: { debug: i },
            });
        expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
        expect(statSync(`${db.raw.name}-wal`).size).toBe(wal);
    });
    it("preserves a stream signature through a later unsigned REST observation", async () => {
        const domain = new SqliteOrdersDomain(H.weth);
        const signed = { ...order.seaportData!, signature: "0x1234" };
        await domain.handleOrderUpsert({
            ...payload(DATA.Stream),
            seaportData: signed,
        });
        await domain.handleOrderUpsert(payload(DATA.Rest));
        const row = db
            .prepare(
                "SELECT seaport_data_json,seaport_data_source_kind FROM orders",
            )
            .get() as {
            seaport_data_json: string;
            seaport_data_source_kind: string;
        };
        expect(JSON.parse(row.seaport_data_json).signature).toBe(
            signed.signature,
        );
        expect(row.seaport_data_source_kind).toBe(DATA.Stream);
    });
    it("enriches a missing signature without changing signed components", async () => {
        const domain = new SqliteOrdersDomain(H.weth);
        await domain.handleOrderUpsert(payload());
        const before = new SqliteOrderValidationDemand(domain).get(
            1,
            order.id,
        )!;
        await domain.handleOrderUpsert({
            ...payload(DATA.Stream),
            seaportData: { ...order.seaportData!, signature: "0x1234" },
        });
        const after = new SqliteOrderValidationDemand(domain).get(1, order.id)!;
        expect(after.revision).toBeGreaterThan(before.revision);
        expect(after.generation).toBeGreaterThan(before.generation);
    });
    it("rejects canonical hints on the source entry without losing a source obligation", async () => {
        const domain = new SqliteOrdersDomain(H.weth);
        await domain.handleOrderUpsert(payload());
        const owner = installHeavyMakerValidationChain();
        const demands = new SqliteOrderValidationDemand(domain);
        const before = demands.get(1, order.id)!;
        await expect(
            domain.handleOrderUpdateById({
                chainId: 1,
                orderId: order.id,
                reason: ORDER_UPDATE_REASON.Fill,
                blockNumber: 998,
                blockHash: `0x${"ab".repeat(32)}`,
            } as unknown as OrderUpdateByIdPayload),
        ).rejects.toThrow("source");
        expect(demands.get(1, order.id)).toEqual(before);
        owner.sample();
        expect(demands.hasReady(1, Date.now())).toBe(true);
    });
});
