import { performance } from "node:perf_hooks";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { validateSeaportOrder } from "../src/application/offchain/seaport-validate.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import {
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
} from "../src/domain/orders.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerHint,
    seedHeavyMaker,
    tokenSaleHint,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("heavy-maker workload", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1_000);
        vi.spyOn(logger, "info").mockImplementation(() => {});
        db.exec("DELETE FROM orders; DELETE FROM collections;");
    });
    afterEach(() => vi.restoreAllMocks());

    it("measures the whole-envelope baseline with 9,339 real validations and a sale behind it", async () => {
        const { small, sale } = seedHeavyMaker();
        const rpc = new HeavyMakerRpc();
        let validations = 0;
        let validationMs = 0;
        const domain = new SqliteOrdersDomain(
            HEAVY_MAKER.weth,
            async (order) => {
                const start = performance.now();
                const result = await validateSeaportOrder(
                    rpc,
                    warmConduits,
                    { conduitController: HEAVY_MAKER.controller },
                    order,
                );
                validations++;
                validationMs += performance.now() - start;
                return result;
            },
        );
        const start = performance.now();
        await domain.handleOrderUpdateByMaker(heavyMakerHint());
        const makerMs = performance.now() - start;
        expect(validations).toBe(HEAVY_MAKER.count);
        expect(rpc.reads).toEqual({
            getOrderStatus: 9_339,
            getCounter: 9_339,
            allowance: 9_339,
            balanceOf: 9_339,
        });
        expect(rpc.virtualMs).toBe(373_560);
        const validated = db
            .prepare(
                "SELECT COUNT(*) AS count FROM orders WHERE validated_at > 0",
            )
            .get() as { count: number };
        expect(validated.count).toBe(HEAVY_MAKER.count);
        // Serial maker delivery cannot reach either following message before the whole scan returns.
        await domain.handleOrderUpdateByMaker(heavyMakerHint(small.maker));
        await domain.handleOrderUpdateByMaker(tokenSaleHint(sale));
        expect(validations).toBe(HEAVY_MAKER.count + 2);
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(sale.id),
        ).toEqual({ fillability_status: ORDER_STATUS.NoBalance });
        await domain.handleOrderUpdateById({
            chainId: sale.chainId,
            orderId: sale.id,
            reason: "fill",
            sourceStatus: ORDER_SOURCE_STATUS.Filled,
            observedAt: HEAVY_MAKER.now,
        });
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(sale.id),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Filled });
        process.stdout.write(
            JSON.stringify({
                scenario: "heavy-maker-baseline-fake-rpc",
                orders: HEAVY_MAKER.count,
                contractReads: 37_356,
                syntheticRpcMs: 373_560,
                makerMs: Math.round(makerMs),
                validationMs: Math.round(validationMs),
                otherLocalMs: Math.round(makerMs - validationMs),
            }) + "\n",
        );
    }, 60_000);

    it("demonstrates replay from the first order after interruption beyond one page", async () => {
        seedHeavyMaker(510);
        const visited: string[] = [];
        const interrupted = new SqliteOrdersDomain(
            HEAVY_MAKER.weth,
            async (order) => {
                if (visited.length === 500)
                    throw new Error("simulated interruption");
                visited.push(order.id);
                return { status: ORDER_STATUS.Fillable, reason: "fixture" };
            },
        );
        await expect(
            interrupted.handleOrderUpdateByMaker(heavyMakerHint()),
        ).rejects.toThrow("simulated interruption");
        const resumed: string[] = [];
        const restarted = new SqliteOrdersDomain(
            HEAVY_MAKER.weth,
            async (order: OrderRecord) => {
                resumed.push(order.id);
                return { status: ORDER_STATUS.Fillable, reason: "fixture" };
            },
        );
        await restarted.handleOrderUpdateByMaker(heavyMakerHint());
        expect(resumed).toHaveLength(510);
        expect(resumed.slice(0, 500)).toEqual(visited);
    });
});
