import { existsSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
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
    const makers = new SqliteMakerRevalidations(domain);
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
