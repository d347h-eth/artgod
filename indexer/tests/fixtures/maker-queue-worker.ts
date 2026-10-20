import { validationChainFixture } from "../helpers/validation-chain-fixture.js";
// Maintained child-process fixture: explicit synthetic DB, fake RPC, private test broker.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { db, setDbPath } from "@artgod/shared/database";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { logger } from "@artgod/shared/utils";
import { RevalidateMakerOrders } from "../../src/application/orders/revalidate-maker.js";
import { startMakerRevalidationRecovery } from "../../src/application/orders/recover-maker-revalidations.js";
import { createSeaportOrderValidationFactory } from "../../src/application/offchain/seaport-validation-batch.js";
import { startQueueOutboxDrainer } from "../../src/application/queue-outbox/drainer.js";
import { runWorker } from "../../src/application/worker-runner.js";
import { SqliteOrdersDomain } from "../../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../../src/infra/orders/sqlite-maker-revalidations.js";
import { FairOrderValidationAdmission } from "../../src/infra/orders/fair-validation-admission.js";
import { SqliteOrderValidationDemand } from "../../src/infra/orders/sqlite-order-validation-demand.js";
import { ApplyOrderUpdate } from "../../src/application/orders/apply-order-update.js";
import {
    ValidateOrderDemand,
    startOrderValidationDemand,
} from "../../src/application/orders/validate-order-demand.js";
import type { OrderValidationAdmissionPort } from "../../src/ports/order-validation-admission.js";
import {
    ORDER_PROCESSING_POLICY,
    ORDER_UPDATE_WORKER_POLICY,
} from "../../src/domain/order-processing.js";
import { makerUpdateHandler } from "../../src/infra/queue/maker-update-handler.js";
import { orderUpdateHandler } from "../../src/infra/queue/order-update-handler.js";
import {
    QUEUE_FIXTURE_CONSUMER as CONSUMER,
    QUEUE_FIXTURE_PHASE as PHASE,
    QUEUE_FIXTURE_COMMAND as COMMAND,
    type QueueFixtureProgress,
} from "./order-queue-protocol.js";
import { SqliteQueueOutbox } from "../../src/infra/queue/sqlite-queue-outbox.js";
import { NatsJetStreamQueue } from "../../src/infra/queue/nats.js";
import { MAKER_REVALIDATION_STATUS } from "../../src/domain/maker-revalidation.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
    type OrderMakerContinuationPayload,
} from "../../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../../src/domain/queues.js";
import { HEAVY_MAKER, HeavyMakerRpc } from "./heavy-maker.js";

const root = process.env.ARTGOD_WORKSPACE_ROOT;
if (!root)
    throw new Error("ARTGOD_WORKSPACE_ROOT is required for the worker fixture");
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
    dbPath: string;
    natsUrl: string;
    prefix: string;
    clockMs: number;
    holdAtRead: number | null;
    holdOrderIds?: string[];
    failOrderIds?: string[];
    advanceClock?: boolean;
    rpcDelayMs?: number;
    reportEvery?: number;
};
if (
    !path
        .resolve(config.dbPath)
        .startsWith(path.join(root, "tmp") + path.sep) ||
    !/^nats:\/\/127\.0\.0\.1:\d+$/.test(config.natsUrl)
)
    throw new Error(
        "Worker fixture requires isolated worktree storage and loopback broker",
    );
const startedAt = performance.now();
const initialCpu = process.cpuUsage();
Date.now = () =>
    config.clockMs +
    (config.advanceClock ? Math.floor(performance.now() - startedAt) : 0);
logger.info = () => {};
logger.debug = () => {};
setDbPath(config.dbPath);
// The fixture's seeded orders represent already observed active declarations.
// Keep those source facts on restart; this is fixture setup, never migration recovery.
db.prepare(
    "INSERT OR IGNORE INTO order_source_observations(chain_id,collection_id,order_id,source_id,source_status,observation_key,source_observed_at,admitted_at,expires_at) " +
        "SELECT chain_id,collection_id,id,source,source_status,'fixture-declaration:'||id,observed_at,?,valid_until*1000+? FROM orders",
).run(config.clockMs, MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds * 1000);
const rpc = new HeavyMakerRpc();
// Advancing the retry clock cannot change the identity of the accepted block.
rpc.blockTimestamp = HEAVY_MAKER.now;
const releaseRpc = Promise.withResolvers<void>();
const heldOrderIds = new Set(config.holdOrderIds ?? []);
const failedOrderIds = new Set(config.failOrderIds ?? []);
rpc.onRead = async ({ functionName, args }) => {
    if (config.rpcDelayMs) await delay(config.rpcDelayMs);
    if (
        functionName === "getOrderStatus" &&
        failedOrderIds.has(String(args?.[0]))
    )
        throw new Error("Fixture persistent order read failure");
    if (
        functionName === "getOrderStatus" &&
        heldOrderIds.delete(String(args?.[0]))
    ) {
        process.send?.({ phase: PHASE.RpcHeld, orderId: args?.[0] });
        await releaseRpc.promise;
    }
    if (
        functionName === "getOrderStatus" &&
        rpc.reads.getOrderStatus === config.holdAtRead
    ) {
        process.send?.({ phase: PHASE.Held, reads: rpc.reads.getOrderStatus });
        await new Promise<void>(() => {});
    }
};
const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth);
const demandStore = new SqliteOrderValidationDemand(domain);
const store = new SqliteMakerRevalidations(
    domain,
    demandStore,
    HEAVY_MAKER.weth,
);
const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.natsUrl,
    streamPrefix: config.prefix,
});
const consumerName = CONSUMER.Maker;
const tokenConsumerName = CONSUMER.Token;
const makerQueues = [
    { queueName: QUEUE_NAMES.OrdersUpdateByMaker, consumerName },
    {
        queueName: QUEUE_NAMES.OrdersUpdateByToken,
        consumerName: tokenConsumerName,
    },
];
const sharedAdmission = new FairOrderValidationAdmission(
    ORDER_PROCESSING_POLICY.concurrentValidations,
);
let activeValidations = 0;
let maximumValidations = 0;
const admission: OrderValidationAdmissionPort = {
    run: (work, signal) =>
        sharedAdmission.run(async () => {
            activeValidations++;
            maximumValidations = Math.max(
                maximumValidations,
                activeValidations,
            );
            try {
                return await work();
            } finally {
                activeValidations--;
            }
        }, signal),
};
const snapshotFactory = createSeaportOrderValidationFactory({
    chainId: HEAVY_MAKER.chainId,
    rpc,
    conduitController: HEAVY_MAKER.controller,
});
const createSnapshot = snapshotFactory;
const processor = new RevalidateMakerOrders({ store });
// This process owns only its explicitly supplied disposable fixture database.
db.prepare(
    "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id IN (SELECT DISTINCT collection_id FROM orders)",
).run(HEAVY_MAKER.blockNumber - 1);
const fixtureChain = validationChainFixture({
    chainId: HEAVY_MAKER.chainId,
    rpc,
    collectionIds: (
        db
            .prepare(
                "SELECT DISTINCT c.collection_id AS id FROM collections c JOIN orders o ON o.chain_id=c.chain_id AND o.collection_id=c.collection_id WHERE c.chain_id=?",
            )
            .all(HEAVY_MAKER.chainId) as { id: number }[]
    ).map((row) => row.id),
});
db.prepare(
    "UPDATE orders SET validation_ready=1 WHERE kind='seaport' AND seaport_data_json IS NOT NULL",
).run();
await fixtureChain.apply();
const sampling = setInterval(() => {
    void fixtureChain.apply();
}, 50);
let maximumAttempt = 0;
let maximumOutbox = 0;
const stopWorkers: Array<() => Promise<void>> = [];
for (const subscription of makerQueues)
    stopWorkers.push(
        await runWorker<
            OrderUpdateByMakerPayload | OrderMakerContinuationPayload
        >(
            queue,
            {
                queue: subscription.queueName,
                consumerName: subscription.consumerName,
                maxInFlight: 1,
                ackWaitMs: 1_000,
                extendLeaseMs: 100,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job, origin) => {
                maximumAttempt = Math.max(maximumAttempt, job.attempt);
                await makerUpdateHandler({
                    chainId: HEAVY_MAKER.chainId,
                    queueName: subscription.queueName,
                    processor,
                })(job, origin);
                const rowCount = db
                    .prepare("SELECT COUNT(*) AS count FROM queue_outbox")
                    .get() as { count: number };
                maximumOutbox = Math.max(maximumOutbox, rowCount.count);
                // Reporting must not admit a second independent run for a coalesced hint.
                const identity =
                    job.kind === ORDER_JOB_KIND.ContinueMaker
                        ? (job.payload as OrderMakerContinuationPayload)
                        : (db
                              .prepare(
                                  "SELECT run_id AS runId FROM maker_order_revalidation_runs WHERE chain_id=? AND source_job_id=?",
                              )
                              .get(job.chainId, job.jobId) as
                              | { runId: string }
                              | undefined);
                const run = identity ? store.get(identity.runId) : undefined;
                if (!run) return;
                if (run.status === MAKER_REVALIDATION_STATUS.Completed) {
                    const heavy = db
                        .prepare(
                            "SELECT resolved_orders+deferred_orders AS expanded FROM maker_order_revalidation_runs WHERE source_job_id=?",
                        )
                        .get("heavy") as { expanded: number } | undefined;
                    process.send?.({
                        phase: PHASE.Complete,
                        jobId: run.sourceJobId,
                        heavyExpanded: heavy?.expanded,
                        reads: rpc.reads,
                        maximumAttempt,
                        maximumOutbox,
                        maximumValidations,
                        runRows: (
                            db
                                .prepare(
                                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                                )
                                .get() as { count: number }
                        ).count,
                    });
                }
            },
        ),
    );
const applyUpdate = new ApplyOrderUpdate({
    chainId: HEAVY_MAKER.chainId,
    lifecycle: domain,
});
let handled = 0,
    sourceRechecks = 0,
    sourceLifecycleUpdates = 0,
    sqliteAdmissionMs = 0,
    maximumSourceAgeMs = 0;
const measuredApply = {
    async execute(...args: Parameters<ApplyOrderUpdate["execute"]>) {
        const start = performance.now();
        await applyUpdate.execute(...args);
        sqliteAdmissionMs += performance.now() - start;
    },
};
function progress(phase: string): QueueFixtureProgress {
    const demand = db
        .prepare(
            "SELECT COUNT(*) AS rows,COALESCE(SUM(pending),0) AS pending,MIN(CASE WHEN pending=1 THEN required_at END) AS oldest FROM order_validation_demand",
        )
        .get() as { rows: number; pending: number; oldest: number | null };
    const cpu = process.cpuUsage(initialCpu);
    return {
        phase,
        handled,
        sourceRechecks,
        sourceLifecycleUpdates,
        elapsedMs: performance.now() - startedAt,
        cpuMs: (cpu.user + cpu.system) / 1000,
        sqliteAdmissionMs,
        maximumValidations,
        reads: rpc.reads,
        pending: demand.pending,
        demandRows: demand.rows,
        oldestDemandAgeMs:
            demand.oldest == null ? 0 : Date.now() - demand.oldest,
        maximumSourceAgeMs,
        allocatedBytes:
            Number(db.raw.pragma("page_count", { simple: true })) *
            Number(db.raw.pragma("page_size", { simple: true })),
        outboxRows: (
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get() as {
                count: number;
            }
        ).count,
        maximumRssKiB: process.resourceUsage().maxRSS,
    };
}
{
    const queueName = QUEUE_NAMES.OrderLifecycle;
    const handleUpdate = orderUpdateHandler({
        chainId: HEAVY_MAKER.chainId,
        apply: measuredApply,
    });
    stopWorkers.push(
        await runWorker<OrderUpdateByIdPayload>(
            queue,
            {
                queue: queueName,
                consumerName: `id-${queueName}-fixture`,
                ...ORDER_UPDATE_WORKER_POLICY,
            },
            async (job) => {
                await handleUpdate(job);
                handled++;
                if (job.payload.reason === ORDER_UPDATE_REASON.Validation)
                    sourceRechecks++;
                else {
                    sourceLifecycleUpdates++;
                    maximumSourceAgeMs = Math.max(
                        maximumSourceAgeMs,
                        Date.now() - job.scheduledAt,
                    );
                }
                if (!config.reportEvery)
                    process.send?.({
                        phase: PHASE.Update,
                        jobId: job.jobId,
                        activeValidations,
                        maximumValidations,
                    });
                else if (handled % config.reportEvery === 0)
                    process.send?.(progress(PHASE.Progress));
            },
        ),
    );
}
const stopValidation = startOrderValidationDemand(
    new ValidateOrderDemand({
        chainId: HEAVY_MAKER.chainId,
        store: demandStore,
        createSnapshot,
        admission,
    }),
);
const stopOutbox = startQueueOutboxDrainer(new SqliteQueueOutbox(), queue, {
    pollMs: 10,
});
const stopRecovery = startMakerRevalidationRecovery({
    store,
    isPublicationPending: (publication, queueName) => {
        const consumer = makerQueues.find(
            (subscription) => subscription.queueName === queueName,
        );
        if (!consumer) throw new Error("Unexpected fixture publication queue");
        return queue.isPublicationPending(publication, consumer.consumerName);
    },
    replayBoundaries: () =>
        Promise.all(
            makerQueues.map((subscription) =>
                queue.getReplayBoundary(subscription.consumerName),
            ),
        ),
});
let stopping = false;
process.on("message", (message) => {
    if (message === COMMAND.ReleaseRpc) {
        releaseRpc.resolve();
        return;
    }
    if (message === COMMAND.Report) {
        process.send?.(progress(PHASE.Progress));
        return;
    }
    if (message !== COMMAND.Stop || stopping) return;
    stopping = true;
    void (async () => {
        await stopRecovery();
        clearInterval(sampling);
        await stopValidation();
        for (const stop of stopWorkers) await stop();
        await stopOutbox();
        await queue.close();
        process.send?.(progress(PHASE.Summary));
        db.raw.close();
        process.exit(0);
    })();
});
process.send?.({ phase: PHASE.Ready });
