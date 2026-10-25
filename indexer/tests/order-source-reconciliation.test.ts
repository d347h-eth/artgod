import { captureOpenSeaSyncIdentity } from "../src/infra/offchain/sqlite-opensea-sync-identity.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_STATUS,
} from "../src/domain/orders.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import { ORDER_UPDATE_REASON } from "../src/domain/order-jobs.js";
import { HEAVY_MAKER as H, heavyMakerOrder } from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const declaration = heavyMakerOrder(0);
const SOURCE = OFFCHAIN_ORDER_SOURCE.OpenSea;
const PEER = "peer-fixture";

describe("source-owned REST reconciliation", () => {
    loadTestEnv();
    let clock: number;
    let orders: SqliteOrdersDomain;
    let demands: SqliteOrderValidationDemand;
    let sourceState: SqliteOrderSourceStateStore;
    beforeEach(async () => {
        clock = H.now;
        vi.spyOn(Date, "now").mockImplementation(() => clock * 1_000);
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(chain_id,collection_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES(1,9,'source-reconciliation',?,'erc721','live','contract_all_tokens',0)",
        ).run(declaration.contract);
        orders = new SqliteOrdersDomain(H.weth, undefined, () => clock);
        demands = new SqliteOrderValidationDemand(orders);
        sourceState = new SqliteOrderSourceStateStore(orders);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });
    const upsert = (source = SOURCE) =>
        orders.handleOrderUpsert({
            ...declaration,
            orderId: declaration.id,
            source,
            observedAt: clock,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        });
    const begin = () =>
        sourceState.beginObservation({
            identity: captureOpenSeaSyncIdentity(1, 9)!,
            source: SOURCE,
            startedAt: clock,
        });
    const aggregate = () =>
        db
            .prepare("SELECT source_status FROM orders WHERE id=?")
            .get(declaration.id);
    const source = (sourceId = SOURCE) =>
        db
            .prepare(
                "SELECT source_status,admitted_at FROM order_source_observations WHERE order_id=? AND source_id=?",
            )
            .get(declaration.id, sourceId);
    async function withdraw() {
        clock += POLICY.orderRevalidationSeconds + 1;
        const observation = begin();
        try {
            return await observation.complete();
        } finally {
            observation.close();
        }
    }

    it.each([
        [SOURCE, PEER],
        [PEER, SOURCE],
    ])(
        "withdraws only OpenSea when declaration sources arrive as %s then %s",
        async (first, second) => {
            await upsert(first);
            await upsert(second);
            const before = demands.get(1, declaration.id);
            expect(await withdraw()).toBe(1);
            expect(source()).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Inactive,
            });
            expect(source(PEER)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
            expect(aggregate()).toEqual({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
            expect(demands.get(1, declaration.id)).toMatchObject({
                pending: true,
                generation: before!.generation + 1,
                admissionSequence: before!.admissionSequence + 1,
            });
            const withdrawn = demands.get(1, declaration.id);
            expect(await withdraw()).toBe(0);
            expect(demands.get(1, declaration.id)).toEqual(withdrawn);
        },
    );

    it("rolls back source withdrawal when the coupled validation admission fails", async () => {
        await upsert();
        await upsert(PEER);
        const before = demands.get(1, declaration.id);
        vi.spyOn(
            SqliteOrderValidationDemand.prototype,
            "admit",
        ).mockImplementation(() => {
            throw new Error("fixture admission failure");
        });
        await expect(withdraw()).rejects.toThrow("fixture admission failure");
        expect(source()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        expect(aggregate()).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        expect(demands.get(1, declaration.id)).toEqual(before);
        expect(
            db.prepare("SELECT * FROM market_order_observations").all(),
        ).toEqual([]);
    });

    it("keeps withdrawal through neutral sale and unrelated inactive observations", async () => {
        await upsert();
        expect(await withdraw()).toBe(1);
        await orders.handleOrderUpdateById({
            chainId: 1,
            collectionId: 9,
            orderId: declaration.id,
            source: SOURCE,
            reason: ORDER_UPDATE_REASON.SourceExecution,
            observedAt: clock,
        });
        await orders.handleOrderUpdateById({
            chainId: 1,
            collectionId: 9,
            orderId: declaration.id,
            source: PEER,
            sourceStatus: ORDER_SOURCE_STATUS.Inactive,
            reason: ORDER_UPDATE_REASON.Validation,
            observedAt: clock,
        });
        expect(source()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Inactive,
        });
        expect(aggregate()).toEqual({
            source_status: ORDER_SOURCE_STATUS.Inactive,
        });
    });

    it("lets a duplicate admitted during the crawl refresh only its source without another validation admission", async () => {
        await upsert();
        const before = demands.get(1, declaration.id);
        clock += POLICY.orderRevalidationSeconds + 1;
        const observation = begin();
        try {
            clock++;
            await upsert();
            expect(source()).toMatchObject({ admitted_at: clock * 1_000 });
            expect(demands.get(1, declaration.id)).toEqual(before);
            expect(await observation.complete()).toBe(0);
            expect(aggregate()).toEqual({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
        } finally {
            observation.close();
        }
    });

    it("does not let another source's freshness prevent an OpenSea withdrawal", async () => {
        await upsert();
        clock += POLICY.orderRevalidationSeconds + 1;
        const observation = begin();
        try {
            clock++;
            await upsert(PEER);
            expect(await observation.complete()).toBe(1);
            expect(source()).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Inactive,
            });
            expect(source(PEER)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
            expect(aggregate()).toEqual({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
        } finally {
            observation.close();
        }
    });
});
