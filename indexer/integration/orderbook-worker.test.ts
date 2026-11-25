import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import captured from "../tests/fixtures/vvv-cash-book.json" with { type: "json" };
import { expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { getSettingDefault } from "@artgod/shared/config/generated-settings-defaults";
import {
    IsolatedNats,
    stopFixtureChild,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import { VVV_MARKET } from "../src/infra/offchain/vvv-orderbook.js";
import { BOOK_VIEW, VVV_READ_INTERVAL_MS } from "../src/domain/orderbook.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { scheduleVvvBooks } from "../src/application/offchain/vvv-reconcile.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import {
    OPENSEA_JOB_KIND,
    OPENSEA_QUEUE_NAME,
    OPENSEA_RECONCILE_REASON,
} from "../src/domain/opensea-jobs.js";

it("runs bounded venue consumers in the packaged worker, keeps an accepted book through an outage and restarts", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const binary = process.env.OPENSEA_RECONCILE_TEST_NATS_BINARY;
    if (!binary) throw new Error("Missing OPENSEA_RECONCILE_TEST_NATS_BINARY");
    await mkdir(path.join(root, "tmp"), { recursive: true });
    const dir = await mkdtemp(path.join(root, "tmp/packaged-orderbooks-"));
    const database = dir + "/book.sqlite";
    const weth = getSettingDefault("WETH_ADDRESS");
    setDbPath(database);
    await createMigrationRunner().runMigrations();
    const broker = await IsolatedNats.start(binary, dir, dir + "/broker");
    const queue = await NatsJetStreamQueue.connect({
        natsUrl: broker.url,
        streamPrefix: "packaged",
    });
    const store = new SqliteOrderSourceStateStore(weth);
    const feed = { ...VVV_MARKET, view: BOOK_VIEW.Public };
    const requests = dir + "/requests";
    await writeFile(requests, "");
    await writeFile(dir + "/mode", "ok");
    await writeFile(dir + "/state.json", JSON.stringify(captured));
    async function launch(enabled: boolean, scheduler = false) {
        const role = scheduler ? "orderbook-reconcile-scheduler-worker" : "orderbook-reconcile-worker";
        const log = await open(dir + (scheduler ? "/scheduler.log" : "/worker.log"), "a");
        const child = spawn(
            process.execPath,
            [
                "--import",
                path.join(
                    root,
                    "indexer/integration/orderbook-fetch-fixture.mjs",
                ),
                path.join(
                    root,
                    "indexer/dist-desktop/" + role + ".mjs",
                ),
            ],
            {
                cwd: root,
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    TMPDIR: dir,
                    ARTGOD_WORKSPACE_ROOT: root,
                    ARTGOD_DB_PATH: database,
                    NATS_URL: broker.url,
                    NATS_STREAM_PREFIX: "packaged",
                    CHAIN_ID: "1",
                    WETH_ADDRESS: weth,
                    OPENSEA_INTEGRATION_MODE: enabled ? "enabled" : "disabled",
                    OPENSEA_API_KEY: enabled ? "fixture" : "",
                    ORDERBOOK_FIXTURE_DIR: dir,
                    ORDERBOOK_FIXTURE_SCHEDULER: scheduler ? String(VVV_READ_INTERVAL_MS) : "",
                    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
                        ? {
                              PLAYWRIGHT_BROWSERS_PATH:
                                  process.env.PLAYWRIGHT_BROWSERS_PATH,
                          }
                        : {}),
                },
                stdio: ["ignore", log.fd, log.fd],
            },
        );
        await log.close();
        return child;
    }
    let child = await launch(false);
    let scheduler = await launch(false, true);
    const state = () =>
        db
            .prepare(
                "SELECT generation,last_success_ms,last_error FROM orderbook_feeds WHERE venue=?",
            )
            .get(feed.venue) as {
            generation: number;
            last_success_ms: number;
            last_error: string | null;
        };
    let tick = Date.now();
    const schedule = async () => {
        // Advance only the test clock for due selection; delivery is due now.
        tick = Math.max(tick, Date.now()) + VVV_READ_INTERVAL_MS;
        await scheduleVvvBooks(
            store,
            {
                publish: (q, j) =>
                    queue.publish(q, { ...j, scheduledAt: Date.now() }),
            },
            1,
            tick,
        );
    };
    async function refreshOpenSea(jobId: string) {
        const count = () =>
            (
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM opensea_orderbook_runs WHERE status='completed'",
                    )
                    .get() as { n: number }
            ).n;
        const previous = count();
        await queue.publish(OPENSEA_QUEUE_NAME.Reconcile, {
            jobId: jobId,
            kind: OPENSEA_JOB_KIND.ReconcileCollection,
            queue: OPENSEA_QUEUE_NAME.Reconcile,
            payload: {
                chainId: 1,
                collectionId: 99,
                reason: OPENSEA_RECONCILE_REASON.Manual,
            },
            chainId: 1,
            attempt: 0,
            scheduledAt: Date.now(),
        });
        await waitForFixture(() => count() > previous, "OpenSea " + jobId);
    }
    try {
        await waitForFixture(
            async () =>
                (await readFile(dir + "/worker.log", "utf8")).includes(
                    "worker ready",
                ),
            "keyless readiness",
        );
        await waitForFixture(async () => (await readFile(dir + "/scheduler.log","utf8")).includes("scheduler worker ready"),"keyless scheduler readiness");
        expect(await readFile(requests, "utf8")).toBe("");
        await stopFixtureChild(scheduler);
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug,opensea_status) VALUES(99,1,'fixture',?,'erc721','live','contract_all_tokens','fixture','ready')",
        ).run(feed.contract);
        await stopFixtureChild(child);
        child = await launch(true);
        scheduler = await launch(true,true);
        await waitForFixture(() => !!db.prepare("SELECT 1 FROM opensea_orderbook_runs WHERE status='completed'").get(), "scheduled OpenSea-only refresh");
        expect(await readFile(requests, "utf8")).not.toContain("browser");
        await stopFixtureChild(child);
        await stopFixtureChild(scheduler);
        store.bind(feed, 99);
        child = await launch(false);
        scheduler = await launch(false,true);
        await waitForFixture(() => state().generation === 1, "first VVV book");
        // Age the prior attempt so the next periodic scheduler tick is due.
        db.prepare("UPDATE orderbook_feeds SET last_attempt_ms=? WHERE venue=?").run(Date.now()-VVV_READ_INTERVAL_MS,feed.venue);
        await waitForFixture(
            () => state().generation === 2,
            "periodic VVV book",
        );
        expect(
            db
                .prepare(
                    "SELECT native_id FROM orderbook_members WHERE present=1 ORDER BY native_id",
                )
                .all(),
        ).toHaveLength(2);
        await stopFixtureChild(scheduler);
        const success = state().last_success_ms;
        await writeFile(dir + "/mode", "deny");
        await schedule();
        await waitForFixture(() => !!state().last_error, "failed VVV read");
        expect(state().last_success_ms).toBe(success);
        await stopFixtureChild(child);
        child = await launch(true);
        scheduler = await launch(true, true);
        await writeFile(dir + "/mode", "interrupt");
        await schedule();
        await waitForFixture(
            async () =>
                (await readFile(requests, "utf8")).split("vvv").length >= 5,
            "interrupted in-page read",
        );
        await refreshOpenSea("combined");
        expect(state().generation).toBe(2);
        await stopFixtureChild(child, "SIGKILL");
        await writeFile(
            dir + "/state.json",
            JSON.stringify({ ...captured, orders: [] }),
        );
        await writeFile(dir + "/mode", "ok");
        child = await launch(true);
        await schedule();
        await waitForFixture(
            () => state().generation >= 3,
            "VVV restart recovery",
            55_000,
        );
        expect(
            db
                .prepare(
                    "SELECT native_id FROM orderbook_members WHERE present=1",
                )
                .all(),
        ).toEqual([]);
    } finally {
        await stopFixtureChild(scheduler);
        await stopFixtureChild(child);
        await queue.close();
        await broker.stop();
        db.raw.close();
    }
}, 100_000);
