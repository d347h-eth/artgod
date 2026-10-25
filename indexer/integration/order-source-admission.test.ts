import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveNatsJobStreamName } from "@artgod/shared/queue/nats-job-stream";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { computeSeaportOrderHash } from "../src/domain/seaport-protocol.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { orderUpdateHandler } from "../src/infra/queue/order-update-handler.js";
import { runWorker } from "../src/application/worker-runner.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
} from "../src/domain/order-jobs.js";
import { ORDER_UPDATE_WORKER_POLICY } from "../src/domain/order-processing.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerBlock,
    heavyMakerOrder,
    seedHeavyMaker,
} from "../tests/fixtures/heavy-maker.js";
import { installHeavyMakerValidationChain } from "../tests/helpers/heavy-maker-validation-fixture.js";
import {
    IsolatedNats,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import { loadOrderQueueTestConfig } from "../tests/helpers/order-queue-test-config.js";

it("ACKs durable source demand while sync is behind, serves unrelated ready work, and resumes after restart without receipt RPC", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const base = path.join(root, "tmp/order-source-admission");
    await mkdir(base, { recursive: true });
    const artifacts = await mkdtemp(path.join(base, "run-"));
    const broker = await IsolatedNats.start(
        loadOrderQueueTestConfig().natsBinary,
        artifacts,
        path.join(artifacts, "nats"),
    );
    const prefix = "source-admission",
        consumerName = "source-isolation";
    const queue = await NatsJetStreamQueue.connect({
        natsUrl: broker.url,
        streamPrefix: prefix,
    });
    let stopWorker: (() => Promise<void>) | undefined;
    try {
        const databasePath = path.join(artifacts, "orders.sqlite");
        setDbPath(databasePath);
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(2);
        const chain = installHeavyMakerValidationChain();
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth);
        const demand = new SqliteOrderValidationDemand(domain);
        // Keep declarations active at both the synthetic accepted block and
        // local wall time; broker timers must retain the real process clock.
        db.exec("DELETE FROM orders");
        const observed = [];
        const now = Math.floor(Date.now() / 1000);
        for (let index = 0; index < 2; index++) {
            const order = heavyMakerOrder(index);
            const seaportData = {
                ...order.seaportData!,
                startTime: String(HEAVY_MAKER.now - 60),
                endTime: String(now + 86_400),
            };
            const orderId = computeSeaportOrderHash(seaportData);
            await domain.handleOrderUpsert({
                ...order,
                orderId,
                seaportData,
                rawSourceKind: order.seaportDataSourceKind!,
                observedAt: now,
            });
            observed.push(orderId);
        }
        chain.sample();
        const rpc = new HeavyMakerRpc();
        const receipt = vi.spyOn(rpc, "getTransactionReceipt");
        const processor = (store: SqliteOrderValidationDemand) =>
            new ValidateOrderDemand({
                chainId: 1,
                store,
                admission: new FairOrderValidationAdmission(2),
                createSnapshot: createSeaportOrderValidationFactory({
                    chainId: 1,
                    rpc,
                    conduitController: HEAVY_MAKER.controller,
                }),
            });
        stopWorker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrderLifecycle,
                consumerName,
                ...ORDER_UPDATE_WORKER_POLICY,
            },
            orderUpdateHandler({
                chainId: 1,
                apply: new ApplyOrderUpdate({ chainId: 1, lifecycle: domain }),
            }),
        );
        const publish = (id: string, payload: OrderUpdateByIdPayload) =>
            queue.publish(QUEUE_NAMES.OrderLifecycle, {
                jobId: id,
                kind: ORDER_JOB_KIND.UpdateById,
                chainId: 1,
                queue: QUEUE_NAMES.OrderLifecycle,
                scheduledAt: Date.now(),
                attempt: 0,
                payload,
            });
        const [sale, ready] = observed as [string, string];
        const generation = demand.get(1, sale)!.generation;
        await publish("sale-not-yet-seen", {
            chainId: 1,
            orderId: sale,
            collectionId: heavyMakerOrder(0).collectionId,
            observedAt: now,
            source: "opensea",
            reason: ORDER_UPDATE_REASON.SourceExecution,
            executionTransactionHash: HEAVY_MAKER.saleTransactionHash,
        });
        await waitForFixture(
            () => (demand.get(1, sale)?.generation ?? 0) > generation,
            "durable source admission",
        );
        chain.progress.recordHeadSample(
            chain.progress.captureHeadSample(1),
            heavyMakerBlock(1001),
            Date.now(),
        );
        expect(demand.get(1, ready)?.pending).toBe(true);
        const manager = await broker.connection.jetstreamManager();
        await waitForFixture(async () => {
            const info = await manager.consumers.info(
                resolveNatsJobStreamName(prefix),
                consumerName,
            );
            return info.num_ack_pending === 0 && info.num_pending === 0;
        }, "all queue deliveries acknowledged before sync catches up");
        const info = await manager.consumers.info(
            resolveNatsJobStreamName(prefix),
            consumerName,
        );
        expect(info.config.max_ack_pending).toBe(1);
        expect(info.num_redelivered).toBe(0);
        expect(await processor(demand).executeBatch()).toMatchObject({
            covered: 1,
            retried: 0,
        });
        expect(demand.get(1, sale)).toMatchObject({
            pending: true,
            failures: 0,
            leaseOwner: null,
        });
        expect(demand.get(1, ready)?.pending).toBe(false);
        expect(await processor(demand).executeBatch()).toBeUndefined();
        expect(receipt).not.toHaveBeenCalled();
        await stopWorker();
        stopWorker = undefined;
        db.raw.close();
        setDbPath(databasePath);
        const restarted = new SqliteOrderValidationDemand(
            new SqliteOrdersDomain(HEAVY_MAKER.weth),
        );
        expect(restarted.get(1, sale)?.pending).toBe(true);
        installHeavyMakerValidationChain().advance(1001);
        expect(await processor(restarted).executeBatch()).toMatchObject({
            covered: 1,
            retried: 0,
        });
        expect(restarted.get(1, sale)).toMatchObject({
            pending: false,
            proofBlock: 1001,
        });
        expect(receipt).not.toHaveBeenCalled();
    } finally {
        await stopWorker?.();
        await queue.close();
        await broker.stop();
    }
}, 30_000);
