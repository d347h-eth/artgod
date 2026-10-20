import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { ORDER_STATUS } from "../src/domain/orders.js";
import { MAKER_REVALIDATION_STATUS } from "../src/domain/maker-revalidation.js";
import {
    HEAVY_MAKER,
    heavyMakerHint,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import {
    makerValidationWorkflow,
    makerFixtureOrigin,
} from "./helpers/maker-validation-workflow.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const request = {
    jobId: "maker-handoff",
    payload: heavyMakerHint(),
    origin: makerFixtureOrigin,
};
const now = HEAVY_MAKER.now * 1000;
describe("maker expansion through the ordinary validation owner", () => {
    loadTestEnv();
    let path: string;
    let clock: number;
    beforeEach(async () => {
        clock = now;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        path = await createTempDbPath();
        setDbPath(path);
        await createMigrationRunner().runMigrations();
    });
    afterEach(() => vi.restoreAllMocks());
    const count = (status: string) =>
        (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE maker=? AND fillability_status=?",
                )
                .get(HEAVY_MAKER.maker, status) as { count: number }
        ).count;

    it("accounts for every order before RPC and isolates a persistent read failure without blocking healthy demand", async () => {
        seedHeavyMaker(205);
        let work = makerValidationWorkflow();
        await work.prepare();
        const run = await work.expand(request);
        expect(run).toMatchObject({
            status: MAKER_REVALIDATION_STATUS.Completed,
            deferredOrders: 205,
        });
        expect(work.rpc.reads).toEqual({});
        const broken = (
            db
                .prepare(
                    "SELECT id FROM orders WHERE maker=? ORDER BY id LIMIT 1",
                )
                .get(HEAVY_MAKER.maker) as { id: string }
        ).id;
        const fail = ({ functionName, args }: any) => {
            if (functionName === "getOrderStatus" && args?.[0] === broken)
                throw new Error("fixture unavailable status");
        };
        work.rpc.onRead = fail;
        await work.validateReady();
        expect(work.demand.get(1, broken)?.pending).toBe(true);
        db.raw.close();
        setDbPath(path);
        work = makerValidationWorkflow();
        work.rpc.onRead = fail;
        for (
            let attempt = 0;
            attempt < 5 && count(ORDER_STATUS.Fillable) !== 204;
            attempt++
        ) {
            const due = db
                .prepare(
                    "SELECT MIN(next_attempt_at) AS due FROM order_validation_demand WHERE pending=1",
                )
                .get() as { due: number };
            clock = Math.max(clock, due.due);
            await work.validateReady();
        }
        expect(count(ORDER_STATUS.Fillable)).toBe(204);
        expect(work.demand.get(1, broken)).toMatchObject({
            pending: true,
            proofAt: null,
        });
        work.rpc.onRead = undefined;
        clock = (
            db
                .prepare(
                    "SELECT next_attempt_at AS due FROM order_validation_demand WHERE order_id=?",
                )
                .get(broken) as { due: number }
        ).due;
        await work.validateReady();
        expect(count(ORDER_STATUS.Fillable)).toBe(205);
        expect(work.demand.get(1, broken)?.pending).toBe(false);
    });

    it("keeps a source scope pending for a post-admission sample after its scan finishes", async () => {
        seedHeavyMaker(3);
        const work = makerValidationWorkflow();
        await work.prepare();
        const input = {
            ...request,
            payload: { ...request.payload, blockNumber: null, blockHash: null },
        };
        await work.expand(input);
        expect(work.demand.hasReady(1, clock)).toBe(false);
        expect(await work.validator.executeBatch()).toBeUndefined();
        expect(work.rpc.reads).toEqual({});
        await work.chain.apply();
        expect((await work.validateReady()).applied).toBe(3);
    });

    it("retains a newer maker generation arriving while an ordinary snapshot is in flight", async () => {
        seedHeavyMaker(3);
        const work = makerValidationWorkflow();
        await work.prepare();
        const input = {
            ...request,
            payload: { ...request.payload, blockNumber: null, blockHash: null },
        };
        await work.expand(input);
        await work.chain.apply();
        let once = true;
        work.rpc.onRead = async () => {
            if (!once) return;
            once = false;
            await work.expand({
                ...input,
                jobId: "new-useful-source-observation",
            });
        };
        await work.validator.executeBatch();
        expect(
            db
                .prepare(
                    "SELECT DISTINCT pending,admission_sequence FROM order_validation_demand",
                )
                .all(),
        ).toEqual([{ pending: 1, admission_sequence: 2 }]);
        expect(work.demand.hasReady(1, clock)).toBe(false);
        work.rpc.onRead = undefined;
        await work.chain.apply();
        expect((await work.validateReady()).applied).toBe(3);
        expect(count(ORDER_STATUS.Fillable)).toBe(3);
    });
});
