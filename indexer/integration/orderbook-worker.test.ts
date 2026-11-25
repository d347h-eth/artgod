import { spawn } from "node:child_process";
import {
    access,
    mkdir,
    mkdtemp,
    open,
    readFile,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { VVV_MARKET } from "../src/infra/offchain/vvv-orderbook.js";
import { BOOK_VIEW, VVV_READ_INTERVAL_MS } from "../src/domain/orderbook.js";
import { ORDERBOOK_SCHEDULER_POLL_MS } from "../src/config/orderbook-reconcile-worker.js";
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
    const runtime = path.join(root, "src-tauri/resources/runtime");
    const node = path.join(
        runtime,
        "node",
        process.platform === "win32" ? "node.exe" : "node",
    );
    await access(node);
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
    await writeFile(dir + "/opensea-mode", "ok");
    await writeFile(dir + "/mode", "ok");
    await writeFile(dir + "/state.json", JSON.stringify(captured));
    async function launch(enabled: boolean, scheduler = false) {
        const role = scheduler
            ? "orderbook-reconcile-scheduler-worker"
            : "orderbook-reconcile-worker";
        const log = await open(
            dir + (scheduler ? "/scheduler.log" : "/worker.log"),
            "a",
        );
        const child = spawn(
            node,
            [
                "--import",
                pathToFileURL(
                    path.join(
                        root,
                        "indexer/integration/orderbook-fetch-fixture.mjs",
                    ),
                ).href,
                path.join(runtime, "indexer/dist-desktop/" + role + ".mjs"),
            ],
            {
                cwd: runtime,
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    TMPDIR: dir,
                    ARTGOD_WORKSPACE_ROOT: runtime,
                    ARTGOD_DB_PATH: database,
                    NATS_URL: broker.url,
                    NATS_STREAM_PREFIX: "packaged",
                    CHAIN_ID: "1",
                    WETH_ADDRESS: weth,
                    OPENSEA_INTEGRATION_MODE: enabled ? "enabled" : "disabled",
                    OPENSEA_API_KEY: enabled ? "fixture" : "",
                    // VVV keeps its own cadence even when OpenSea runs hourly.
                    OPENSEA_RECONCILE_INTERVAL_MS: "3600000",
                    ORDERBOOK_FIXTURE_DIR: dir,
                    ORDERBOOK_FIXTURE_SCHEDULER: scheduler
                        ? String(ORDERBOOK_SCHEDULER_POLL_MS)
                        : "",
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
    async function retryInitialOpenSeaRead() {
        const runId = Number(
            db
                .prepare(
                    "INSERT INTO bootstrap_runs(chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,request_image_cache_mode,status) SELECT chain_id,collection_id,slug,address,standard,?,?,?,? FROM collections WHERE collection_id=99",
                )
                .run(
                    BOOTSTRAP_METADATA_MODE.BestEffort,
                    BOOTSTRAP_ENUMERATION_MODE.Enumerable,
                    IMAGE_CACHE_MODE.Off,
                    BOOTSTRAP_RUN_STATUS.Queued,
                ).lastInsertRowid,
        );
        const insert = db.prepare(
            "INSERT INTO bootstrap_run_steps(run_id,step_key,status) VALUES(?,?,?)",
        );
        for (const key of [
            BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
            BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            BOOTSTRAP_STEP_KEY.OpenSeaReady,
            BOOTSTRAP_STEP_KEY.Metadata,
        ])
            insert.run(runId, key, BOOTSTRAP_STEP_STATUS.Pending);
        const status = (key: string) =>
            (
                db
                    .prepare(
                        "SELECT status FROM bootstrap_run_steps WHERE run_id=? AND step_key=?",
                    )
                    .get(runId, key) as { status: string }
            ).status;
        await writeFile(dir + "/opensea-mode", "reject-offers");
        await queue.publish(OPENSEA_QUEUE_NAME.Reconcile, {
            jobId: "initial-with-retry",
            queue: OPENSEA_QUEUE_NAME.Reconcile,
            kind: OPENSEA_JOB_KIND.BootstrapCollection,
            payload: { chainId: 1, collectionId: 99, bootstrap: { runId } },
            chainId: 1,
            collectionId: 99,
            scheduledAt: Date.now(),
            attempt: 1,
        });
        await waitForFixture(
            () =>
                status(BOOTSTRAP_STEP_KEY.OpenSeaSnapshot) ===
                BOOTSTRAP_STEP_STATUS.FailedRetry,
            "first read records its failed final page",
        );
        expect(status(BOOTSTRAP_STEP_KEY.OpenSeaIdentity)).toBe(
            BOOTSTRAP_STEP_STATUS.Succeeded,
        );
        expect(status(BOOTSTRAP_STEP_KEY.OpenSeaReady)).toBe(
            BOOTSTRAP_STEP_STATUS.Pending,
        );
        await writeFile(dir + "/opensea-mode", "ok");
        await waitForFixture(
            () =>
                status(BOOTSTRAP_STEP_KEY.OpenSeaReady) ===
                BOOTSTRAP_STEP_STATUS.Succeeded,
            "reconciler retries the original bootstrap run",
        );
        expect(status(BOOTSTRAP_STEP_KEY.OpenSeaSnapshot)).toBe(
            BOOTSTRAP_STEP_STATUS.Succeeded,
        );
        expect(status(BOOTSTRAP_STEP_KEY.Metadata)).toBe(
            BOOTSTRAP_STEP_STATUS.Pending,
        );
    }
    try {
        await waitForFixture(
            async () =>
                (await readFile(dir + "/worker.log", "utf8")).includes(
                    "worker ready",
                ),
            "keyless readiness",
        );
        await waitForFixture(
            async () =>
                (await readFile(dir + "/scheduler.log", "utf8")).includes(
                    "scheduler worker ready",
                ),
            "keyless scheduler readiness",
        );
        expect(await readFile(requests, "utf8")).toBe("");
        await stopFixtureChild(scheduler);
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug,opensea_status) VALUES(99,1,'fixture',?,'erc721','live','contract_all_tokens','fixture','ready')",
        ).run(feed.contract);
        await stopFixtureChild(child);
        child = await launch(true);
        scheduler = await launch(true, true);
        await waitForFixture(
            () =>
                !!db
                    .prepare(
                        "SELECT 1 FROM opensea_orderbook_runs WHERE status='completed'",
                    )
                    .get(),
            "scheduled OpenSea-only refresh",
        );
        expect(await readFile(requests, "utf8")).not.toContain("browser");
        await stopFixtureChild(scheduler);
        await retryInitialOpenSeaRead();
        await stopFixtureChild(child);
        store.bind(feed, 99);
        child = await launch(false);
        scheduler = await launch(false, true);
        await waitForFixture(() => state().generation === 1, "first VVV book");
        const ageBook = () =>
            db
                .prepare(
                    "UPDATE orderbook_feeds SET last_attempt_ms=@due,last_success_ms=@due WHERE venue=@venue",
                )
                .run({
                    due: Date.now() - VVV_READ_INTERVAL_MS,
                    venue: feed.venue,
                });
        ageBook();
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
        const recovered = state().generation;
        ageBook();
        await waitForFixture(
            () => state().generation > recovered,
            "scheduled VVV refresh with an hourly OpenSea cadence",
        );
        const closes = async () =>
            (await readFile(requests, "utf8")).split("closed\n").length - 1;
        const previousCloses = await closes();
        store.unbind(feed, 99);
        await waitForFixture(
            async () => (await closes()) > previousCloses,
            "last removed VVV binding releases its browser",
            35_000,
        );
        await refreshOpenSea("after-last-vvv-binding");
    } finally {
        await stopFixtureChild(scheduler);
        await stopFixtureChild(child);
        await queue.close();
        await broker.stop();
        db.raw.close();
    }
}, 130_000);
