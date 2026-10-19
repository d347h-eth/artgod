import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveNatsJobStreamName } from "@artgod/shared/queue/nats-job-stream";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteOrderExecutionRequirements } from "../src/infra/orders/sqlite-order-execution-requirements.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import {
    AdmitOrderValidation,
    startOrderValidationDemand,
} from "../src/application/orders/validate-order-demand.js";
import { ResolveOrderExecutions } from "../src/application/orders/resolve-order-executions.js";
import { orderUpdateHandler } from "../src/infra/queue/order-update-handler.js";
import { runWorker } from "../src/application/worker-runner.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
} from "../src/domain/order-jobs.js";
import { ORDER_UPDATE_WORKER_POLICY } from "../src/domain/order-processing.js";
import { ORDER_VALIDATION_DEMAND_POLICY } from "../src/domain/order-validation-demand.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    HEAVY_MAKER,
    heavyMakerOrder,
    seedHeavyMaker,
} from "../tests/fixtures/heavy-maker.js";
import {
    IsolatedNats,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import { loadOrderQueueTestConfig } from "../tests/helpers/order-queue-test-config.js";

it("ACKs a missing receipt's durable handoff and processes unrelated by-ID work through retries and restart", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const base = path.join(root, "tmp/order-execution-receipts");
    await mkdir(base, { recursive: true });
    const artifacts = await mkdtemp(path.join(base, "run-"));
    const broker = await IsolatedNats.start(
        loadOrderQueueTestConfig().natsBinary,
        artifacts,
        path.join(artifacts, "nats"),
    );
    const prefix = "execution-receipts";
    const consumerName = "receipt-isolation";
    const queue = await NatsJetStreamQueue.connect({
        natsUrl: broker.url,
        streamPrefix: prefix,
    });
    let stopWorker: (() => Promise<void>) | undefined;
    let stopReceipts: (() => Promise<void>) | undefined;
    try {
        setDbPath(path.join(artifacts, "orders.sqlite"));
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(2);
        db.prepare("UPDATE orders SET valid_until=?").run(
            Math.floor(Date.now() / 1000) + 3600,
        );
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
            throw new Error("unused");
        });
        const demand = new SqliteOrderValidationDemand(domain);
        const store = new SqliteOrderExecutionRequirements(demand);
        const apply = new ApplyOrderUpdate({
            chainId: 1,
            lifecycle: domain,
            validation: new AdmitOrderValidation(1, demand),
            executionValidation: store,
        });
        const admission = new FairOrderValidationAdmission(2);
        let receiptReads = 0;
        const executionBlock = {
            resolve: async () => {
                receiptReads++;
                throw new Error("receipt unavailable");
            },
        };
        const processor = new ResolveOrderExecutions({
            chainId: 1,
            store,
            admission,
            executionBlock,
        });
        stopWorker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpdateById,
                consumerName,
                ...ORDER_UPDATE_WORKER_POLICY,
            },
            orderUpdateHandler({
                chainId: 1,
                queueName: QUEUE_NAMES.OrdersUpdateById,
                apply,
            }),
        );
        stopReceipts = startOrderValidationDemand(
            processor,
            undefined,
            ORDER_VALIDATION_DEMAND_POLICY.receiptExecutors,
        );
        const publish = async (id: string, payload: OrderUpdateByIdPayload) =>
            queue.publish(QUEUE_NAMES.OrdersUpdateById, {
                jobId: id,
                kind: ORDER_JOB_KIND.UpdateById,
                chainId: 1,
                queue: QUEUE_NAMES.OrdersUpdateById,
                scheduledAt: Date.now(),
                attempt: 0,
                payload,
            });
        await publish("missing-receipt", {
            chainId: 1,
            orderId: heavyMakerOrder(0).id,
            reason: ORDER_UPDATE_REASON.SourceExecutionValidation,
            executionTransactionHash: HEAVY_MAKER.saleTransactionHash,
        });
        await waitForFixture(
            () => receiptReads >= 1,
            "first missing receipt attempt",
        );
        await publish("unrelated", {
            chainId: 1,
            orderId: heavyMakerOrder(1).id,
            reason: ORDER_UPDATE_REASON.Validation,
        });
        await waitForFixture(
            () => demand.get(1, heavyMakerOrder(1).id)?.pending === true,
            "unrelated by-ID admission",
        );
        const manager = await broker.connection.jetstreamManager();
        await waitForFixture(
            async () =>
                (
                    await manager.consumers.info(
                        resolveNatsJobStreamName(prefix),
                        consumerName,
                    )
                ).num_ack_pending === 0,
            "broker ACKs independent of receipt",
        );
        await waitForFixture(
            () => receiptReads >= 2,
            "independent receipt retry",
        );
        const info = await manager.consumers.info(
            resolveNatsJobStreamName(prefix),
            consumerName,
        );
        expect(info.config.max_ack_pending).toBe(1);
        expect(info.num_pending).toBe(0);
        expect(info.num_redelivered).toBe(0);
        expect(
            db
                .prepare("SELECT failures FROM order_execution_requirements")
                .get(),
        ).toMatchObject({ failures: 2 });
        await stopReceipts();
        stopReceipts = undefined;
        // New application/store objects resume the retained obligation without replay.
        const restarted = new ResolveOrderExecutions({
            chainId: 1,
            store: new SqliteOrderExecutionRequirements(demand),
            admission,
            executionBlock: { resolve: async () => HEAVY_MAKER.blockNumber },
        });
        stopReceipts = startOrderValidationDemand(
            restarted,
            undefined,
            ORDER_VALIDATION_DEMAND_POLICY.receiptExecutors,
        );
        await waitForFixture(
            () =>
                demand.get(1, heavyMakerOrder(0).id)?.minimumBlock ===
                HEAVY_MAKER.blockNumber,
            "restart receipt handoff",
        );
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_execution_requirements",
                )
                .get(),
        ).toEqual({ count: 0 });
    } finally {
        await stopReceipts?.();
        await stopWorker?.();
        await queue.close();
        await broker.stop();
    }
}, 30_000);
