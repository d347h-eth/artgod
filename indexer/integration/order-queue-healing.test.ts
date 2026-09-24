import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { buildOrderQueueTestWorker } from "../../scripts/build/build-order-queue-test-worker.mjs";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveNatsJobStreamName } from "@artgod/shared/queue/nats-job-stream";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByMakerPayload,
} from "../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    MAKER_REVALIDATION_POLICY,
    MAKER_REVALIDATION_STATUS,
} from "../src/domain/maker-revalidation.js";
import { loadOrderQueueTestConfig } from "../tests/helpers/order-queue-test-config.js";
import {
    IsolatedNats,
    stopFixtureChild,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import {
    HEAVY_MAKER,
    seedHeavyMaker,
    heavyMakerHint,
    tokenSaleHint,
} from "../tests/fixtures/heavy-maker.js";

type WorkerReport = {
    phase: string;
    jobId?: string;
    heavyResolved?: number;
    reads?: Record<string, number>;
    maximumAttempt?: number;
    maximumOutbox?: number;
};

it("services small work between real-broker steps and recovers after killing a worker and restarting NATS", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const { natsBinary } = loadOrderQueueTestConfig();
    const base = path.join(root, "tmp/order-queue-healing-nats");
    await mkdir(base, { recursive: true });
    const artifacts = await mkdtemp(path.join(base, "run-"));
    const store = path.join(artifacts, "nats");
    const dbPath = path.join(artifacts, "orders.sqlite");
    const workerArtifact = path.join(artifacts, "maker-worker.mjs");
    await buildOrderQueueTestWorker(workerArtifact);
    const children = new Set<ChildProcess>();
    const queues = new Set<NatsJetStreamQueue>();
    let broker: IsolatedNats | undefined;
    const results: Record<string, unknown> = {};

    async function worker(
        prefix: string,
        clockMs: number,
        holdAtRead: number | null,
    ) {
        const configPath = path.join(
            artifacts,
            `worker-${prefix}-${clockMs}.json`,
        );
        await writeFile(
            configPath,
            JSON.stringify({
                dbPath,
                natsUrl: broker!.url,
                prefix,
                clockMs,
                holdAtRead,
            }),
        );
        const child = spawn(process.execPath, [workerArtifact, configPath], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            env: { ...process.env, ARTGOD_WORKSPACE_ROOT: root },
        });
        children.add(child);
        let output = "";
        child.stdout!.on("data", (chunk) => {
            output = (output + String(chunk)).slice(-6_000);
        });
        child.stderr!.on("data", (chunk) => {
            output = (output + String(chunk)).slice(-6_000);
        });
        const reports: WorkerReport[] = [];
        child.on("message", (message) => reports.push(message as WorkerReport));
        const wait = async (check: () => boolean, label: string) =>
            waitForFixture(() => {
                if (child.exitCode !== null || child.signalCode !== null)
                    throw new Error(`Worker exited during ${label}: ${output}`);
                return check();
            }, label);
        await wait(
            () => reports.some((r) => r.phase === "ready"),
            "worker startup",
        );
        return {
            child,
            reports,
            wait,
            async stop() {
                child.send("stop");
                await waitForFixture(
                    () => child.exitCode !== null || child.signalCode !== null,
                    "graceful worker exit",
                );
                expect(child.exitCode, output).toBe(0);
                children.delete(child);
            },
        };
    }

    async function publish(
        prefix: string,
        jobs: Array<{ id: string; payload: OrderUpdateByMakerPayload }>,
    ) {
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: broker!.url,
            streamPrefix: prefix,
        });
        queues.add(queue);
        for (const job of jobs)
            await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, {
                jobId: job.id,
                kind: ORDER_JOB_KIND.UpdateByMaker,
                queue: QUEUE_NAMES.OrdersUpdateByMaker,
                payload: job.payload,
                chainId: 1,
                scheduledAt: HEAVY_MAKER.now * 1_000,
                attempt: 0,
            });
        await queue.close();
        queues.delete(queue);
    }

    async function drained(prefix: string) {
        const manager = await broker!.connection.jetstreamManager();
        await waitForFixture(async () => {
            const consumer = await manager.consumers.info(
                resolveNatsJobStreamName(prefix),
                "maker-healing-fixture",
            );
            return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
        }, "all maker messages acknowledged");
        const stream = await manager.streams.info(
            resolveNatsJobStreamName(prefix),
        );
        expect(stream.state.messages).toBe(0);
    }

    try {
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
        const { small, sale } = seedHeavyMaker();
        db.raw.close();
        broker = await IsolatedNats.start(natsBinary, artifacts, store);
        await publish("fairness", [
            { id: "heavy", payload: heavyMakerHint() },
            { id: "small", payload: heavyMakerHint(small.maker) },
            { id: "sale", payload: tokenSaleHint(sale) },
        ]);
        const start = performance.now();
        const fair = await worker("fairness", HEAVY_MAKER.now * 1_000, null);
        await fair.wait(
            () =>
                fair.reports.filter((r) => r.phase === "complete").length === 3,
            "heavy and small jobs finish",
        );
        await drained("fairness");
        await fair.stop();
        const completed = fair.reports.filter((r) => r.phase === "complete");
        expect(completed.map((r) => r.jobId)).toEqual([
            "small",
            "sale",
            "heavy",
        ]);
        expect(completed[0]!.heavyResolved).toBe(100);
        expect(completed[1]!.heavyResolved).toBe(100);
        expect(completed[2]!.heavyResolved).toBe(HEAVY_MAKER.count);
        expect(completed[2]!.maximumAttempt).toBe(1);
        expect(completed[2]!.maximumOutbox).toBe(1);
        results.fairness = {
            ...completed[2],
            completionOrder: completed.map((r) => r.jobId),
            localMs: Math.round(performance.now() - start),
        };

        setDbPath(dbPath);
        db.exec(
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
        );
        seedHeavyMaker(510);
        db.raw.close();
        await publish("restart", [{ id: "heavy", payload: heavyMakerHint() }]);
        const interrupted = await worker(
            "restart",
            HEAVY_MAKER.now * 1_000,
            101,
        );
        await interrupted.wait(
            () => interrupted.reports.some((r) => r.phase === "held"),
            "worker awaits second-context RPC",
        );
        await stopFixtureChild(interrupted.child, "SIGKILL");
        children.delete(interrupted.child);
        setDbPath(dbPath);
        expect(
            db
                .prepare(
                    "SELECT resolved_orders,status FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({
            resolved_orders: 100,
            status: MAKER_REVALIDATION_STATUS.Pending,
        });
        db.raw.close();
        await broker.stop();
        broker = await IsolatedNats.start(natsBinary, artifacts, store);
        const resumed = await worker(
            "restart",
            HEAVY_MAKER.now * 1_000 + MAKER_REVALIDATION_POLICY.leaseMs + 1,
            null,
        );
        await resumed.wait(
            () => resumed.reports.some((r) => r.phase === "complete"),
            "interrupted run resumes",
        );
        await drained("restart");
        await resumed.stop();
        const recovered = resumed.reports.find((r) => r.phase === "complete")!;
        expect(recovered.reads?.getOrderStatus).toBe(410);
        expect(recovered.heavyResolved).toBe(510);
        results.restart = recovered;
        await writeFile(
            path.join(artifacts, "results.json"),
            JSON.stringify(results, null, 2) + "\n",
        );
        console.log(JSON.stringify(results, null, 2));
    } finally {
        for (const child of children) await stopFixtureChild(child, "SIGKILL");
        for (const queue of queues) await queue.close();
        await broker?.stop();
        try {
            db.raw.close();
        } catch {}
    }
}, 120_000);
