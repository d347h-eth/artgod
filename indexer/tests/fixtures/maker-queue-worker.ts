// Maintained child-process fixture: explicit synthetic DB, fake RPC, private test broker.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { db, setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { RevalidateMakerOrders } from "../../src/application/orders/revalidate-maker.js";
import { startMakerRevalidationRecovery } from "../../src/application/orders/recover-maker-revalidations.js";
import { createSeaportOrderValidationFactory } from "../../src/application/offchain/seaport-validation-batch.js";
import { validateSeaportOrder } from "../../src/application/offchain/seaport-validate.js";
import { startQueueOutboxDrainer } from "../../src/application/queue-outbox/drainer.js";
import { runWorker } from "../../src/application/worker-runner.js";
import { SqliteOrdersDomain } from "../../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../../src/infra/orders/sqlite-maker-revalidations.js";
import { FairOrderValidationAdmission } from "../../src/infra/orders/fair-validation-admission.js";
import { SqliteOrderValidationDemand } from "../../src/infra/orders/sqlite-order-validation-demand.js";
import { ApplyOrderUpdate } from "../../src/application/orders/apply-order-update.js";
import {
    AdmitOrderValidation,
    ValidateOrderDemand,
    startOrderValidationDemand,
} from "../../src/application/orders/validate-order-demand.js";
import type { OrderValidationAdmissionPort } from "../../src/ports/order-validation-admission.js";
import {
    ORDER_PROCESSING_POLICY,
    ORDER_UPDATE_WORKER_POLICY,
} from "../../src/domain/order-processing.js";
import { orderUpdateHandler } from "../../src/infra/queue/order-update-handler.js";
import {
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
} from "../../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../../src/domain/queues.js";
import { HEAVY_MAKER, HeavyMakerRpc, warmConduits } from "./heavy-maker.js";

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
const rpc = new HeavyMakerRpc();
rpc.blockTimestamp = Math.floor(config.clockMs / 1_000);
const releaseRpc = Promise.withResolvers<void>();
const heldOrderIds = new Set(config.holdOrderIds ?? []);
rpc.onRead = async ({ functionName, args }) => {
    if (config.rpcDelayMs) await delay(config.rpcDelayMs);
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
const validateOrder = (order: Parameters<typeof validateSeaportOrder>[3]) =>
    validateSeaportOrder(
        rpc,
        warmConduits,
        { conduitController: HEAVY_MAKER.controller },
        order,
    );
const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, validateOrder);
const store = new SqliteMakerRevalidations(domain);
const demandStore = new SqliteOrderValidationDemand(domain);
const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.natsUrl,
    streamPrefix: config.prefix,
});
const consumerName = "maker-healing-fixture";
const tokenConsumerName = "token-healing-fixture";
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
    run: (work) =>
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
        }),
};
const snapshotFactory = createSeaportOrderValidationFactory({
    chainId: HEAVY_MAKER.chainId,
    rpc,
    conduits: warmConduits,
    conduitController: HEAVY_MAKER.controller,
});
const createSnapshot: typeof snapshotFactory = (input) => {
    rpc.blockTimestamp = Math.floor(Date.now() / 1000);
    return snapshotFactory(input);
};
const processor = new RevalidateMakerOrders({
    admission,
    store,
    createSnapshot,
});
let maximumAttempt = 0;
let maximumOutbox = 0;
const stopWorkers: Array<() => Promise<void>> = [];
for (const subscription of makerQueues)
    stopWorkers.push(
        await runWorker<OrderUpdateByMakerPayload>(
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
                if (job.kind !== ORDER_JOB_KIND.UpdateByMaker)
                    throw new Error("Unexpected fixture job kind");
                maximumAttempt = Math.max(maximumAttempt, job.attempt);
                await processor.execute({
                    jobId: job.jobId,
                    payload: job.payload,
                    requiredAt: job.scheduledAt,
                    origin,
                });
                const rowCount = db
                    .prepare("SELECT COUNT(*) AS count FROM queue_outbox")
                    .get() as { count: number };
                maximumOutbox = Math.max(maximumOutbox, rowCount.count);
                // Reporting must not admit a second independent run for a coalesced hint.
                const identity =
                    job.payload.continuation ??
                    (db
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
                            "SELECT resolved_orders AS resolved FROM maker_order_revalidation_runs WHERE source_job_id=?",
                        )
                        .get("heavy") as { resolved: number } | undefined;
                    process.send?.({
                        phase: PHASE.Complete,
                        jobId: run.sourceJobId,
                        heavyResolved: heavy?.resolved,
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
    validation: new AdmitOrderValidation(HEAVY_MAKER.chainId, demandStore),
    lifecycle: domain,
});
let handled = 0,
    validationHints = 0,
    terminalFacts = 0,
    sqliteAdmissionMs = 0,
    maximumTerminalAgeMs = 0;
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
        validationHints,
        terminalFacts,
        elapsedMs: performance.now() - startedAt,
        cpuMs: (cpu.user + cpu.system) / 1000,
        sqliteAdmissionMs,
        maximumValidations,
        reads: rpc.reads,
        pending: demand.pending,
        demandRows: demand.rows,
        oldestDemandAgeMs:
            demand.oldest == null ? 0 : Date.now() - demand.oldest,
        maximumTerminalAgeMs,
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
for (const queueName of [
    QUEUE_NAMES.OrdersUpdateById,
    QUEUE_NAMES.OrderLifecycle,
]) {
    const handleUpdate = orderUpdateHandler({
        chainId: HEAVY_MAKER.chainId,
        queueName,
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
                if (
                    job.payload.reason === ORDER_UPDATE_REASON.Validation &&
                    !job.payload.sourceStatus
                )
                    validationHints++;
                else {
                    terminalFacts++;
                    maximumTerminalAgeMs = Math.max(
                        maximumTerminalAgeMs,
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
