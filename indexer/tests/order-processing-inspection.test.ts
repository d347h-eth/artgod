import { existsSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    inspectOrderProcessing,
    parseOrderInspectionArgs,
} from "../scripts/order-processing-inspection.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import {
    HEAVY_MAKER,
    seedHeavyMaker,
    heavyMakerOrder,
    heavyMakerHint,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

loadTestEnv();
let databasePath: string;
beforeAll(async () => {
    databasePath = await createTempDbPath();
    setDbPath(databasePath);
    await createMigrationRunner().runMigrations();
});
beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1000);
    db.exec(
        "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
    );
});
afterEach(() => vi.restoreAllMocks());

it("requires explicit identity and bounds the read-only sample", () => {
    expect(() => parseOrderInspectionArgs([])).toThrow("--chain-id");
    expect(() => parseOrderInspectionArgs(["--chain-id", "1"])).toThrow("--db");
    expect(() =>
        parseOrderInspectionArgs([
            "--chain-id",
            "1",
            "--db",
            databasePath,
            "--limit",
            "1001",
        ]),
    ).toThrow("limit");
    const config = parseOrderInspectionArgs([
        "--",
        "--chain-id",
        "1",
        "--db",
        databasePath,
    ]);
    expect(config).toMatchObject({ chainId: 1, limit: 25, counts: false });
    const missing = databasePath + ".missing";
    expect(() =>
        inspectOrderProcessing({ ...config, databasePath: missing }),
    ).toThrow();
    expect(existsSync(missing)).toBe(false);
});

it("reports bounded pending work and its wakeup without changing SQLite or hiding unsampled work", () => {
    seedHeavyMaker(3);
    const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
        throw new Error("Inspection cannot use RPC");
    });
    const demands = new SqliteOrderValidationDemand(domain);
    const now = HEAVY_MAKER.now * 1000;
    for (let i = 0; i < 3; i++)
        demands.admit(
            {
                chainId: 1,
                orderId: heavyMakerOrder(i).id,
                requiredAt: now - 1000,
                minimumBlock: null,
            },
            now,
        );
    const makers = new SqliteMakerRevalidations(domain, demands);
    const run = makers.admit({
        jobId: "inspect-fixture",
        payload: heavyMakerHint(),
        requiredAt: now,
        now,
    });
    const claimed = makers.claim(run.runId, "fixture-owner", now)!;
    makers.checkpoint(claimed, [], false, now);
    const before = db.raw.pragma("data_version", { simple: true });
    const config = { databasePath, chainId: 1, limit: 1, counts: false };
    const sampled = inspectOrderProcessing(config, now);
    expect(sampled.demandSample).toHaveLength(1);
    expect(sampled.demandSample[0]).toMatchObject({ ageMs: 1000 });
    expect(sampled.makerSample).toHaveLength(1);
    expect(sampled.makerSample[0]?.wakeup).toBeTruthy();
    expect(sampled.counts).toBeNull();
    expect(
        inspectOrderProcessing({ ...config, counts: true }, now).counts
            ?.demands,
    ).toEqual([{ pending: 1, count: 3 }]);
    expect(db.raw.pragma("data_version", { simple: true })).toBe(before);
});

it("distinguishes due, leased and retrying work and reports age outside the sample", () => {
    db.exec("DELETE FROM orders; DELETE FROM collections;");
    seedHeavyMaker(3);
    const demands = new SqliteOrderValidationDemand(
        new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
            throw new Error("Inspection cannot use RPC");
        }),
    );
    const now = HEAVY_MAKER.now * 1000;
    for (let i = 0; i < 3; i++)
        demands.admit(
            {
                chainId: 1,
                orderId: heavyMakerOrder(i).id,
                requiredAt: now - (i === 2 ? 120_000 : 1000),
                minimumBlock: null,
            },
            now,
        );
    db.prepare(
        "UPDATE order_validation_demand SET lease_until=? WHERE order_id=?",
    ).run(now + 1000, heavyMakerOrder(1).id);
    db.prepare(
        "UPDATE order_validation_demand SET failures=1,next_attempt_at=? WHERE order_id=?",
    ).run(now + 1000, heavyMakerOrder(2).id);
    const config = { databasePath, chainId: 1, limit: 1, counts: true };
    const result = inspectOrderProcessing(config, now);
    expect(result.demandSample[0]?.ageMs).toBe(1000);
    expect(result.counts?.pendingDemand).toEqual({
        count: 3,
        due: 1,
        leased: 1,
        backoff: 1,
        withFailures: 1,
        oldestRequiredAt: now - 120000,
        oldestRequiredAgeMs: 120000,
    });
    db.exec("DELETE FROM orders;");
    expect(inspectOrderProcessing(config, now).counts?.pendingDemand).toEqual({
        count: 0,
        due: 0,
        leased: 0,
        backoff: 0,
        withFailures: 0,
        oldestRequiredAt: null,
        oldestRequiredAgeMs: null,
    });
});
