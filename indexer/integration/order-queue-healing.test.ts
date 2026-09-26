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
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
} from "../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import {
    ORDER_PROCESSING_POLICY,
    makerUpdateQueue,
    orderUpdateQueue,
} from "../src/domain/order-processing.js";
import {
    MAKER_REVALIDATION_POLICY,
    MAKER_REVALIDATION_STATUS,
} from "../src/domain/maker-revalidation.js";
import { ORDER_VALIDATION_DEMAND_POLICY } from "../src/domain/order-validation-demand.js";
import { QUEUE_FIXTURE_PHASE } from "../tests/fixtures/order-queue-protocol.js";
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
    runRows?: number;
    orderId?: string;
    activeValidations?: number;
    maximumValidations?: number;
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
        holdOrderIds: string[] = [],
        failOrderIds: string[] = [],
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
                holdOrderIds,
                failOrderIds,
                advanceClock: failOrderIds.length > 0,
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
        await waitForFixture(
            async () =>
                (await manager.streams.info(resolveNatsJobStreamName(prefix)))
                    .state.messages === 0,
            "all routed messages acknowledged",
        );
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
            ...Array.from({ length: 200 }, (_, i) => ({
                id: `heavy-hint-${i}`,
                payload: heavyMakerHint(),
            })),
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
        expect(completed[2]!.runRows).toBe(3);
        expect(completed[2]!.reads?.getOrderStatus).toBe(HEAVY_MAKER.count + 2);
        results.fairness = {
            ...completed[2],
            completionOrder: completed.map((r) => r.jobId),
            coalescedMakerHints: 200,
            localMs: Math.round(performance.now() - start),
        };

        setDbPath(dbPath);
        db.exec(
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
        );
        const mixed = seedHeavyMaker(510);
        const first = db
            .prepare("SELECT id FROM orders WHERE maker=? ORDER BY id LIMIT 1")
            .get(HEAVY_MAKER.maker) as { id: string };
        db.raw.close();
        await publish("routing", [{ id: "heavy", payload: heavyMakerHint() }]);
        const routingQueue = await NatsJetStreamQueue.connect({
            natsUrl: broker.url,
            streamPrefix: "routing",
        });
        queues.add(routingQueue);
        const publishUpdate = async (
            id: string,
            payload: OrderUpdateByIdPayload,
        ) => {
            const queueName = orderUpdateQueue(payload);
            await routingQueue.publish(queueName, {
                jobId: id,
                kind: ORDER_JOB_KIND.UpdateById,
                queue: queueName,
                payload,
                chainId: 1,
                scheduledAt: HEAVY_MAKER.now * 1_000,
                attempt: 0,
            });
        };
        await publishUpdate("ordinary", {
            chainId: 1,
            orderId: mixed.small.id,
            reason: ORDER_UPDATE_REASON.Validation,
        });
        const routed = await worker("routing", HEAVY_MAKER.now * 1_000, null, [
            first.id,
            mixed.small.id,
        ]);
        await routed.wait(
            () =>
                routed.reports.filter((r) => r.phase === "rpc-held").length ===
                2,
            "maker and ordinary RPC hold both shared permits",
        );
        const urgentStart = performance.now();
        await publishUpdate("fill", {
            chainId: 1,
            collectionId: mixed.small.collectionId,
            orderId: mixed.small.id,
            reason: ORDER_UPDATE_REASON.Fill,
            sourceStatus: ORDER_SOURCE_STATUS.Filled,
            observedAt: HEAVY_MAKER.now,
        });
        const tokenPayload = tokenSaleHint(mixed.sale);
        const tokenQueue = makerUpdateQueue(tokenPayload);
        await routingQueue.publish(tokenQueue, {
            jobId: "token",
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: tokenQueue,
            payload: tokenPayload,
            chainId: 1,
            scheduledAt: HEAVY_MAKER.now * 1_000,
            attempt: 0,
        });
        await routed.wait(
            () =>
                routed.reports.some(
                    (r) => r.phase === "update" && r.jobId === "fill",
                ),
            "fill bypasses blocked validation",
        );
        const fill = routed.reports.find(
            (r) => r.phase === "update" && r.jobId === "fill",
        )!;
        expect(fill.activeValidations).toBe(
            ORDER_PROCESSING_POLICY.concurrentValidations,
        );
        expect(routed.reports.some((r) => r.phase === "complete")).toBe(false);
        const lifecycleMs = Math.round(performance.now() - urgentStart);
        routed.child.send("release-rpc");
        await routed.wait(
            () =>
                routed.reports.filter((r) => r.phase === "complete").length ===
                2,
            "targeted and broad work settle",
        );
        await drained("routing");
        await routed.stop();
        const routedCompletions = routed.reports.filter(
            (r) => r.phase === "complete",
        );
        expect(routedCompletions.map((r) => r.jobId)).toEqual([
            "token",
            "heavy",
        ]);
        expect(
            routedCompletions.every(
                (r) =>
                    r.maximumValidations ===
                    ORDER_PROCESSING_POLICY.concurrentValidations,
            ),
        ).toBe(true);
        setDbPath(dbPath);
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(mixed.small.id),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Filled });
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(mixed.sale.id),
        ).toEqual({ fillability_status: ORDER_STATUS.NoBalance });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1",
                )
                .get(),
        ).toEqual({ count: 0 });
        db.raw.close();
        results.routing = {
            lifecycleMs,
            activeValidationsAtFill: fill.activeValidations,
            maximumValidations: fill.maximumValidations,
            completionOrder: routedCompletions.map((r) => r.jobId),
        };
        await routingQueue.close();
        queues.delete(routingQueue);

        setDbPath(dbPath);
        db.exec(
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
        );
        seedHeavyMaker(250);
        const failed = db
            .prepare(
                "SELECT id FROM orders WHERE maker=? ORDER BY id LIMIT 1 OFFSET 40",
            )
            .get(HEAVY_MAKER.maker) as { id: string };
        db.raw.close();
        await publish("handoff", [{ id: "heavy", payload: heavyMakerHint() }]);
        const handingOff = await worker(
            "handoff",
            HEAVY_MAKER.now * 1000,
            null,
            [],
            [failed.id],
        );
        await handingOff.wait(
            () =>
                handingOff.reports.some(
                    (report) => report.phase === QUEUE_FIXTURE_PHASE.Complete,
                ),
            "maker scan finishes despite one persistently failing order",
        );
        await drained("handoff");
        await handingOff.stop();
        setDbPath(dbPath);
        expect(
            db
                .prepare(
                    "SELECT status,resolved_orders,deferred_orders FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({
            status: MAKER_REVALIDATION_STATUS.Completed,
            resolved_orders: 249,
            deferred_orders: 1,
        });
        expect(
            db
                .prepare(
                    "SELECT pending,proof_revision FROM order_validation_demand WHERE order_id=?",
                )
                .get(failed.id),
        ).toEqual({ pending: 1, proof_revision: null });
        db.raw.close();
        await broker.stop();
        broker = await IsolatedNats.start(natsBinary, artifacts, store);
        const demandRecovery = await worker(
            "handoff",
            HEAVY_MAKER.now * 1000 +
                ORDER_VALIDATION_DEMAND_POLICY.retryMaxMs +
                10_000,
            null,
        );
        setDbPath(dbPath);
        await demandRecovery.wait(
            () =>
                (
                    db
                        .prepare(
                            "SELECT pending FROM order_validation_demand WHERE order_id=?",
                        )
                        .get(failed.id) as { pending: number }
                ).pending === 0,
            "handed-off demand completes after worker and broker restart",
        );
        await drained("handoff");
        await demandRecovery.stop();
        const recoveryReport = demandRecovery.reports.find(
            (report) => report.phase === QUEUE_FIXTURE_PHASE.Summary,
        )!;
        expect(recoveryReport.reads?.getOrderStatus).toBe(1);
        expect(
            db
                .prepare("SELECT validated_at FROM orders WHERE id=?")
                .get(failed.id),
        ).toEqual({
            validated_at: Math.floor(
                (HEAVY_MAKER.now * 1000 +
                    ORDER_VALIDATION_DEMAND_POLICY.retryMaxMs +
                    10_000) /
                    1000,
            ),
        });
        db.raw.close();
        results.handoff = {
            makerResolved: 249,
            makerDeferred: 1,
            recoveredOrderReads: recoveryReport.reads?.getOrderStatus,
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
