import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { MigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import {
    MAKER_REVALIDATION_STATUS,
    makerValidationScopeKey,
} from "../src/domain/maker-revalidation.js";
import { ORDER_JOB_KIND } from "../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    HEAVY_MAKER,
    heavyMakerHint,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";

// Deliberately assert the migration filename and removed storage columns here.
const MIGRATION = "088_maker_delivery_evidence.sql";

it("disposes only unsupported null-format work and preserves current pending recovery and receipts", async () => {
    loadTestEnv();
    const dbPath = await createTempDbPath();
    const migrations = await mkdtemp(
        path.join(path.dirname(dbPath), "maker-cutover-"),
    );
    const source = resolveProjectPath("database/migrations");
    for (const file of (await readdir(source)).filter(
        (file) => file.endsWith(".sql") && file !== MIGRATION,
    ))
        await copyFile(path.join(source, file), path.join(migrations, file));
    setDbPath(dbPath);
    const runner = new MigrationRunner(migrations);
    await runner.runMigrations();
    seedHeavyMaker(1);
    const orders = new SqliteOrdersDomain(HEAVY_MAKER.weth);
    const store = new SqliteMakerRevalidations(
        orders,
        new SqliteOrderValidationDemand(orders),
        HEAVY_MAKER.weth,
    );
    const origin = {
        streamId: "retained-stream",
        consumerName: "maker-main",
        sequence: 12,
    };
    const payload = { ...heavyMakerHint(), blockNumber: null, blockHash: null };
    const now = HEAVY_MAKER.now * 1_000;
    const current = store.admit({ jobId: "current", payload, origin, now })!;
    store.scheduleWakeup(current, now);
    store.claim(current.runId, "retained-owner", now);
    db.prepare(
        "UPDATE maker_order_revalidation_runs SET origin_stream_id=?,origin_consumer=?,origin_sequence=? WHERE run_id=?",
    ).run(origin.streamId, origin.consumerName, origin.sequence, current.runId);
    const completed = store.admit({
        jobId: "completed",
        payload: { ...payload, maker: HEAVY_MAKER.smallMaker },
        origin,
        now,
    })!;
    db.prepare(
        "UPDATE maker_order_revalidation_runs SET status=? WHERE run_id=?",
    ).run(MAKER_REVALIDATION_STATUS.Completed, completed.runId);
    const outbox = new SqliteQueueOutbox();
    const publish = (id: string) =>
        outbox.enqueueJob({
            jobId: id,
            kind: ORDER_JOB_KIND.ContinueMaker,
            queue: QUEUE_NAMES.OrdersUpdateByMaker,
            chainId: 1,
            scheduledAt: now,
            attempt: 0,
            payload: { id },
        });
    const unrelated = publish("unrelated-publication");
    const unsupported = [
        "scope_key",
        "source_payload_json",
        "requested_payload_json",
    ] as const;
    const blocked = unsupported.map((column, index) => {
        const jobId = `old-${index}`;
        const hint = {
            ...payload,
            maker: `0x${(index + 1).toString(16).padStart(40, "0")}`,
        };
        const raw = JSON.stringify(hint);
        const wakeup = publish(jobId);
        db.prepare(
            "INSERT INTO maker_order_revalidation_runs(run_id,chain_id,source_job_id,payload_json,status,upper_order_id,upper_rowid,created_at,updated_at,scope_key,source_payload_json,requested_payload_json,wakeup_outbox_id) VALUES (?,1,?,?,?,'',0,?,?, ?,?,?,?)",
        ).run(
            jobId,
            jobId,
            raw,
            MAKER_REVALIDATION_STATUS.Pending,
            now,
            now,
            column === "scope_key" ? null : makerValidationScopeKey(hint, 0),
            column === "source_payload_json" ? null : raw,
            column === "requested_payload_json" ? null : raw,
            wakeup,
        );
        db.prepare(
            "INSERT INTO maker_validation_delivery_origins(run_id,consumer_name,stream_id,maximum_sequence) VALUES (?,?,?,?)",
        ).run(jobId, origin.consumerName, origin.streamId, origin.sequence);
        return { jobId, hint, wakeup };
    });
    const currentRows = () =>
        db
            .prepare(
                "SELECT * FROM maker_order_revalidation_runs WHERE run_id IN (?,?) ORDER BY run_id",
            )
            .all(current.runId, completed.runId)
            .map((row: any) => {
                const {
                    origin_stream_id,
                    origin_consumer,
                    origin_sequence,
                    ...retained
                } = row;
                return retained;
            });
    const before = currentRows();
    const currentOrigins = () =>
        db
            .prepare(
                "SELECT * FROM maker_validation_delivery_origins WHERE run_id IN (?,?) ORDER BY run_id",
            )
            .all(current.runId, completed.runId);
    const beforeOrigins = currentOrigins();
    const beforeOutbox = db
        .prepare(
            "SELECT * FROM queue_outbox WHERE outbox_id NOT IN (?,?,?) ORDER BY outbox_id",
        )
        .all(...blocked.map(({ wakeup }) => wakeup));
    await copyFile(
        path.join(source, MIGRATION),
        path.join(migrations, MIGRATION),
    );
    await runner.runMigrations();
    expect(currentRows()).toEqual(before);
    expect(currentOrigins()).toEqual(beforeOrigins);
    expect(
        db.prepare("SELECT * FROM queue_outbox ORDER BY outbox_id").all(),
    ).toEqual(beforeOutbox);
    expect(
        db
            .prepare("SELECT 1 FROM queue_outbox WHERE outbox_id=?")
            .get(unrelated),
    ).toBeDefined();
    expect(
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM maker_validation_delivery_origins",
            )
            .get(),
    ).toEqual({ count: 2 });
    expect(
        (
            db
                .prepare("PRAGMA table_info(maker_order_revalidation_runs)")
                .all() as { name: string }[]
        ).map(({ name }) => name),
    ).not.toContain("origin_sequence");
    for (const { jobId, hint } of blocked)
        expect(
            store.admit({ jobId, payload: hint, origin, now }),
        ).not.toBeNull();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
