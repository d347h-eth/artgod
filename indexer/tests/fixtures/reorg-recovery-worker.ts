// Maintained child fixture: real broker/database/adapters, deterministic RPC.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { db, setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { startReorgRecoveryLoop } from "../../src/application/reorg-recovery.js";
import { startAutomaticSyncLoop } from "../../src/application/automatic-sync-executor.js";
import { createBackfillSyncHandler } from "../../src/application/backfill-sync-handler.js";
import { BackfillExecutionGate } from "../../src/application/backfill-execution.js";
import { startQueueOutboxDrainer } from "../../src/application/queue-outbox/drainer.js";
import { runWorker } from "../../src/application/worker-runner.js";
import { QUEUE_NAMES } from "../../src/domain/queues.js";
import type { JobEnvelope } from "../../src/domain/jobs.js";
import type { BackfillSyncPayload } from "../../src/domain/sync-jobs.js";
import type {
    QueuePort,
    QueueMessage,
    SubscribeOptions,
} from "../../src/ports/queue.js";
import { NatsJetStreamQueue } from "../../src/infra/queue/nats.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
    REORG_FIXTURE,
} from "../helpers/reorg-recovery-fixture.js";
import {
    REORG_FIXTURE_COMMAND as COMMAND,
    REORG_FIXTURE_CONSUMER as CONSUMER,
    REORG_FIXTURE_ROLE as ROLE,
    REORG_FIXTURE_PHASE as PHASE,
    REORG_FIXTURE_PUBLICATION as PUBLICATION,
    type ReorgFixtureConfig,
    type ReorgFixtureReport,
} from "./reorg-recovery-protocol.js";

const root = process.env.ARTGOD_WORKSPACE_ROOT;
if (!root) throw new Error("Missing ARTGOD_WORKSPACE_ROOT");
const config = JSON.parse(
    await readFile(process.argv[2]!, "utf8"),
) as ReorgFixtureConfig;
if (
    !path
        .resolve(config.dbPath)
        .startsWith(path.join(root, "tmp") + path.sep) ||
    !/^nats:\/\/127\.0\.0\.1:\d+$/.test(config.natsUrl)
)
    throw new Error(
        "Reorg fixture requires worktree tmp and a private loopback broker",
    );
const report = (message: ReorgFixtureReport) => process.send?.(message);
logger.info = () => {};
logger.debug = () => {};
setDbPath(config.dbPath);
if (config.role === ROLE.Writer) {
    db.exec("BEGIN IMMEDIATE;");
    report({ phase: PHASE.WriterLocked });
    await delay(config.writerHoldMs!);
    db.exec("COMMIT;");
    report({ phase: PHASE.WriterReleased });
    db.raw.close();
    process.exit(0);
}
const rpc = new RecoveryRpc();
const releaseRpc = Promise.withResolvers<void>();
let ownerHeld = false;
let acquisitionHeld = false;
rpc.beforeLogs = async () => {
    if (config.holdAcquisition && !acquisitionHeld) {
        acquisitionHeld = true;
        report({ phase: PHASE.AcquisitionHeld });
        await releaseRpc.promise;
    }
};
rpc.beforeOwnerRead = async () => {
    if (config.ownerDelayMs) await delay(config.ownerDelayMs);
    if (config.holdOwner && !ownerHeld) {
        ownerHeld = true;
        report({ phase: PHASE.RpcHeld });
        await releaseRpc.promise;
    }
};
const services = reorgRecoveryServices(rpc, {
    retryDelayMs: config.retryDelayMs,
});
if (config.sqliteBusyTimeoutMs !== undefined)
    db.raw.pragma(`busy_timeout = ${config.sqliteBusyTimeoutMs}`);
const transport = await NatsJetStreamQueue.connect({
    natsUrl: config.natsUrl,
    streamPrefix: config.prefix,
});
let ambiguous = config.publication === PUBLICATION.Ambiguous;
let ackDropped = false;
const queue: QueuePort = {
    async publish(name, job) {
        if (
            name === QUEUE_NAMES.MetadataDomain &&
            config.publication === PUBLICATION.FailMetadata
        )
            throw new Error("Fixture metadata publication unavailable");
        if (
            name === QUEUE_NAMES.MetadataDomain &&
            config.publication === PUBLICATION.HoldMetadata
        ) {
            report({ phase: PHASE.FanoutHeld, jobId: job.jobId });
            await new Promise<void>(() => {});
        }
        const result = await transport.publish(name, job);
        if (name === QUEUE_NAMES.MetadataDomain && ambiguous) {
            ambiguous = false;
            report({ phase: PHASE.AmbiguousPublication, jobId: job.jobId });
            throw new Error("Fixture accepted publication with lost reply");
        }
        return result;
    },
    subscribe<TPayload>(
        name: Parameters<QueuePort["subscribe"]>[0],
        handler: (message: QueueMessage<TPayload>) => Promise<void>,
        options: SubscribeOptions,
    ) {
        return transport.subscribe<TPayload>(
            name,
            (message) =>
                handler({
                    ...message,
                    ack: async () => {
                        if (
                            name === QUEUE_NAMES.BackfillSync &&
                            config.dropAckOnce &&
                            !ackDropped
                        ) {
                            ackDropped = true;
                            return;
                        }
                        await message.ack();
                        report({
                            phase: PHASE.Acknowledged,
                            jobId: message.data.jobId,
                            attempt: message.data.attempt,
                        });
                    },
                    touch: async () => {
                        await message.touch();
                        report({
                            phase: PHASE.Touch,
                            jobId: message.data.jobId,
                        });
                    },
                    nack: async (options) => {
                        await message.nack(options);
                        report({
                            phase: PHASE.Deferred,
                            jobId: message.data.jobId,
                            attempt: message.data.attempt,
                        });
                    },
                }),
            options,
        );
    },
    close: () => transport.close(),
};
const stops: Array<() => Promise<void>> = [];
let checkAttempts = 0;
const verifyCheck = services.recovery.checkBlock.bind(services.recovery);
services.recovery.checkBlock = async (check) => {
    const start = performance.now();
    try {
        await verifyCheck(check);
    } finally {
        const pending =
            (
                db
                    .prepare(
                        "SELECT canonical_check_pending AS pending FROM blocks WHERE chain_id=? AND block_number=?",
                    )
                    .get(check.chainId, check.blockNumber) as
                    | { pending: number }
                    | undefined
            )?.pending === 1;
        report({
            phase: PHASE.Checked,
            attempt: ++checkAttempts,
            pending,
            revision: services.storage.captureSyncCheckpoint(1).revision,
            ownerReads: rpc.ownerReads.length,
            rssBytes: process.memoryUsage().rss,
            elapsedMs: Math.round(performance.now() - start),
        });
    }
};
const check = async () => {
    if (!(await services.recovery.checkDue())) {
        await services.recovery.resumeDue();
        report({
            phase: PHASE.Checked,
            pending: false,
            revision: services.storage.captureSyncCheckpoint(1).revision,
            ownerReads: rpc.ownerReads.length,
        });
    }
};
if (config.role === ROLE.All || config.role === ROLE.Reorg || config.resume)
    stops.push(
        startReorgRecoveryLoop(
            {
                resumeDue: () =>
                    config.resume
                        ? services.recovery.resumeDue()
                        : Promise.resolve(),
                checkDue: () => services.recovery.checkDue(),
            },
            20,
        ),
    );
if (config.role === ROLE.All || config.role === ROLE.Resync)
    stops.push(
        await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.BackfillSync,
                consumerName: CONSUMER.Resync,
                maxInFlight: 1,
                ackWaitMs: config.ackWaitMs,
                extendLeaseMs: config.extendLeaseMs,
                maxAttempts: 2,
                retryDelayMs: 20,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            createBackfillSyncHandler({
                reorgDepth: 1,
                chainId: REORG_FIXTURE.ChainId,
                workerCount: 1,
                wethAddress: REORG_FIXTURE.Weth,
                rpc,
                storage: services.storage,
                commit: services.commit,
                collectionsPort: services.registry,
                extensions: { getInstall: () => null },
                bidderIndex: { isActive: () => false, shouldEmit: () => false },
                gate: new BackfillExecutionGate(),
            }),
        ),
    );
if (config.role === ROLE.All || config.role === ROLE.Resync) {
    const runDue = services.executor.runDue.bind(services.executor);
    stops.push(
        startAutomaticSyncLoop(
            {
                runDue: async () => {
                    const before = services.recoveries.getRecovery(
                        REORG_FIXTURE.ChainId,
                    );
                    const busy = await runDue();
                    const after = services.recoveries.getRecovery(
                        REORG_FIXTURE.ChainId,
                    );
                    if (
                        before &&
                        JSON.stringify(before) !== JSON.stringify(after)
                    )
                        report({
                            phase: PHASE.Resynced,
                            completed:
                                before.phase !== after?.phase ||
                                ("fromBlock" in before &&
                                    (!after ||
                                        !("fromBlock" in after) ||
                                        before.fromBlock !== after.fromBlock)),
                            logReads: rpc.logReads,
                        });
                    return busy;
                },
            },
            20,
        ),
    );
}
if (config.publish)
    stops.push(
        startQueueOutboxDrainer(services.outbox, queue, {
            pollMs: 20,
            maxAttempts: 1,
            retryBaseDelayMs: 20,
        }),
    );
process.on("message", (message) => {
    if (message === COMMAND.ReleaseRpc) releaseRpc.resolve();
    if (message === COMMAND.Check) void check();
    if (message === COMMAND.Stop)
        void (async () => {
            await Promise.all(stops.map((stop) => stop()));
            await queue.close();
            db.raw.close();
            process.exit(0);
        })();
});
report({ phase: PHASE.Ready });
