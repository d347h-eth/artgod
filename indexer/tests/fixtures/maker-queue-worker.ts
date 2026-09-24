// Maintained child-process fixture: explicit synthetic DB, fake RPC, private test broker.
import { readFile } from "node:fs/promises";
import path from "node:path";
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
import { SqliteQueueOutbox } from "../../src/infra/queue/sqlite-queue-outbox.js";
import { NatsJetStreamQueue } from "../../src/infra/queue/nats.js";
import { MAKER_REVALIDATION_STATUS } from "../../src/domain/maker-revalidation.js";
import {
    ORDER_JOB_KIND,
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
Date.now = () => config.clockMs;
logger.info = () => {};
setDbPath(config.dbPath);
const rpc = new HeavyMakerRpc();
rpc.blockTimestamp = Math.floor(config.clockMs / 1_000);
rpc.onRead = async ({ functionName }) => {
    if (
        functionName === "getOrderStatus" &&
        rpc.reads.getOrderStatus === config.holdAtRead
    ) {
        process.send?.({ phase: "held", reads: rpc.reads.getOrderStatus });
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
const queue = await NatsJetStreamQueue.connect({
    natsUrl: config.natsUrl,
    streamPrefix: config.prefix,
});
const consumerName = "maker-healing-fixture";
const processor = new RevalidateMakerOrders({
    store,
    createSnapshot: createSeaportOrderValidationFactory({
        chainId: HEAVY_MAKER.chainId,
        rpc,
        conduits: warmConduits,
        conduitController: HEAVY_MAKER.controller,
    }),
});
let maximumAttempt = 0;
let maximumOutbox = 0;
const stopWorker = await runWorker<OrderUpdateByMakerPayload>(
    queue,
    {
        queue: QUEUE_NAMES.OrdersUpdateByMaker,
        consumerName,
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
                .get(job.chainId, job.jobId) as { runId: string } | undefined);
        const run = identity ? store.get(identity.runId) : undefined;
        if (!run) return;
        if (run.status === MAKER_REVALIDATION_STATUS.Completed) {
            const heavy = db
                .prepare(
                    "SELECT resolved_orders AS resolved FROM maker_order_revalidation_runs WHERE source_job_id=?",
                )
                .get("heavy") as { resolved: number } | undefined;
            process.send?.({
                phase: "complete",
                jobId: run.sourceJobId,
                heavyResolved: heavy?.resolved,
                reads: rpc.reads,
                maximumAttempt,
                maximumOutbox,
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
);
const stopOutbox = startQueueOutboxDrainer(new SqliteQueueOutbox(), queue, {
    pollMs: 10,
});
const stopRecovery = startMakerRevalidationRecovery({
    store,
    consumerName,
    isPublicationPending: (publication, consumer) =>
        queue.isPublicationPending(publication, consumer),
    replayBoundary: (consumer) => queue.getReplayBoundary(consumer),
});
let stopping = false;
process.on("message", (message) => {
    if (message !== "stop" || stopping) return;
    stopping = true;
    void (async () => {
        await stopRecovery();
        await stopWorker();
        await stopOutbox();
        await queue.close();
        db.raw.close();
        process.exit(0);
    })();
});
process.send?.({ phase: "ready" });
