import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { ORDER_STATUS } from "../src/domain/orders.js";
import {
    HEAVY_MAKER,
    BatchedHeavyMakerRpc,
    heavyMakerHint,
    seedHeavyMaker,
    tokenSaleHint,
} from "./fixtures/heavy-maker.js";
import {
    makerValidationWorkflow,
    makerFixtureOrigin,
} from "./helpers/maker-validation-workflow.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1000;
describe("heavy maker through bounded scope expansion and one validation executor", () => {
    loadTestEnv();
    beforeEach(async () => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    afterEach(() => vi.restoreAllMocks());
    it("validates all 9,339 bids with bounded shared reads while a small maker can finish before heavy expansion", async () => {
        const { small, sale } = seedHeavyMaker();
        const rpc = new BatchedHeavyMakerRpc();
        const work = makerValidationWorkflow(rpc);
        await work.prepare();
        const input = {
            jobId: "heavy",
            payload: heavyMakerHint(),
            origin: makerFixtureOrigin,
        };
        const first = await work.next(input);
        expect(first?.deferredOrders).toBe(100);
        expect(rpc.reads).toEqual({});
        await work.expand({
            ...input,
            jobId: "small",
            payload: heavyMakerHint(small.maker),
        });
        await work.expand({
            ...input,
            jobId: "sale",
            payload: tokenSaleHint(sale),
        });
        await work.validateReady();
        expect(work.store.get(first!.runId)?.deferredOrders).toBe(100);
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(small.id),
        ).toEqual({ fillability_status: ORDER_STATUS.Fillable });
        const run = await work.expand(input);
        expect(run?.deferredOrders).toBe(HEAVY_MAKER.count);
        const rest = await work.validateReady();
        expect(rest.batches).toBeGreaterThan(90);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE maker=? AND proof_at=? AND fillability_status=?",
                )
                .get(HEAVY_MAKER.maker, now, ORDER_STATUS.Fillable),
        ).toEqual({ count: HEAVY_MAKER.count });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1",
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(rpc.reads.getCounter).toBeLessThan(110);
        expect(rpc.reads.allowance).toBeLessThan(110);
        expect(rpc.reads.balanceOf).toBeLessThan(110);
        expect(rpc.reads.getOrderStatus).toBe(HEAVY_MAKER.count + 2);
    }, 120_000);
});
