import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import { resolveNatsJobStreamName } from "@artgod/shared/queue/nats-job-stream";
import { buildIndexerTestWorker } from "../../scripts/build/build-indexer-test-worker.mjs";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { runWorker } from "../src/application/worker-runner.js";
import { planSyncGapRepairBatches } from "../src/domain/sync-gap-repair.js";
import { startQueueOutboxDrainer } from "../src/application/queue-outbox/drainer.js";
import { SyncGapScheduler } from "../src/application/sync-gap-scheduler.js";
import { createBackfillSyncHandler } from "../src/application/backfill-sync-handler.js";
import { BackfillExecutionGate } from "../src/application/backfill-execution.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import type { BlockCheckPayload } from "../src/domain/reorg-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { REORG_JOB_KIND } from "../src/domain/reorg-jobs.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { QUEUE_OUTBOX_STATUS } from "../src/domain/queue-outbox.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import type { DomainSyncPayload } from "../src/domain/domain-jobs.js";
import {
    IsolatedNats,
    stopFixtureChild,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import { loadReorgRecoveryTestConfig } from "../tests/helpers/reorg-recovery-test-config.js";
import { loadTestEnv } from "../tests/helpers/test-env.js";
import {
    emptyOnChainData,
    insertCollection,
    selectBalanceOwners,
    selectTransferCount,
} from "../tests/helpers/ownership-fixture.js";
import { syncBlockFixture } from "../tests/helpers/chain-fixture.js";
import {
    REORG_FIXTURE as F,
    RecoveryRpc,
    canonicalRecoveryBlock,
    reorgRecoveryServices,
    seedRecoveryHistory,
    pendingRecoveryRange,
} from "../tests/helpers/reorg-recovery-fixture.js";
import {
    REORG_FIXTURE_ROLE as ROLE,
    REORG_FIXTURE_CONSUMER as CONSUMER,
    REORG_FIXTURE_PHASE as PHASE,
    REORG_FIXTURE_COMMAND as COMMAND,
    REORG_FIXTURE_PUBLICATION as PUBLICATION,
    type ReorgFixtureConfig,
    type ReorgFixtureReport,
} from "../tests/fixtures/reorg-recovery-protocol.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import {
    BACKFILL_SOURCE,
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../src/domain/sync-jobs.js";

describe("isolated broker and process reorg recovery", () => {
    loadTestEnv();
    const root = fileURLToPath(new URL("../../", import.meta.url));
    let base: string;
    let workerArtifact: string;
    let artifacts: string;
    let dbPath: string;
    let broker: IsolatedNats;
    let queue: NatsJetStreamQueue;
    let services: ReturnType<typeof reorgRecoveryServices>;
    let collectionId: number;
    const children = new Set<ChildProcess>();
    const stops: Array<() => Promise<void>> = [];
    const reports: ReorgFixtureReport[] = [];
    const fanout: JobEnvelope<DomainSyncPayload>[] = [];
    const deadLetters: JobEnvelope<unknown>[] = [];
    const prefix = "reorg_fixture";
    let childNumber = 0;
    const { natsBinary } = loadReorgRecoveryTestConfig();

    beforeAll(async () => {
        const parent = path.join(root, "tmp/reorg-recovery-nats");
        await mkdir(parent, { recursive: true });
        base = await mkdtemp(path.join(parent, "run-"));
        workerArtifact = path.join(base, "recovery-worker.mjs");
        await buildIndexerTestWorker({
            entryPoint: "indexer/tests/fixtures/reorg-recovery-worker.ts",
            outfile: workerArtifact,
        });
    });
    async function connect() {
        queue = await NatsJetStreamQueue.connect({
            natsUrl: broker.url,
            streamPrefix: prefix,
        });
        for (const name of [
            QUEUE_NAMES.ActivityDomain,
            QUEUE_NAMES.OrdersDomain,
            QUEUE_NAMES.MetadataDomain,
        ])
            stops.push(
                await runWorker<DomainSyncPayload>(
                    queue,
                    {
                        queue: name,
                        consumerName: `fixture-${name}`,
                        maxInFlight: 1,
                        acceptGapWork: true,
                    },
                    async (job) => {
                        fanout.push(job);
                    },
                ),
            );
        stops.push(
            await queue.subscribe(
                QUEUE_NAMES.DeadLetter,
                async (message) => {
                    deadLetters.push(message.data);
                    await message.ack();
                },
                { consumerName: "fixture-dlq", maxInFlight: 1 },
            ),
        );
    }
    beforeEach(async () => {
        artifacts = await mkdtemp(path.join(base, "case-"));
        dbPath = path.join(artifacts, "recovery.sqlite");
        reports.length = 0;
        fanout.length = 0;
        deadLetters.length = 0;
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
        collectionId = seedRecoveryHistory().collectionId;
        services = reorgRecoveryServices(new RecoveryRpc(), {
            retryDelayMs: 300,
        });
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "jetstream"),
        );
        await connect();
    });
    afterEach(async () => {
        for (const child of children) await stopFixtureChild(child, "SIGKILL");
        children.clear();
        for (const stop of stops.splice(0)) await stop();
        await queue?.close();
        await broker?.stop();
        await writeFile(
            path.join(artifacts, "result.json"),
            JSON.stringify({ reports, fanout, deadLetters }, null, 2),
        );
        setDbPath(dbPath);
        db.raw.close();
    });
    it("executes one retained shared gap and publishes only its participating collections through JetStream", async () => {
        db.exec(
            "DELETE FROM collections; DELETE FROM blocks; DELETE FROM transactions;",
        );
        const ids = [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
        ].map((address, i) =>
            insertCollection({
                chainId: F.ChainId,
                slug: `broker-gap-${i}`,
                address,
                anchorBlock: F.Anchor,
            }),
        );
        const rpc = new RecoveryRpc();
        const blockReads: number[] = [];
        rpc.beforeBlockRead = async (number) => {
            blockReads.push(number);
        };
        services = reorgRecoveryServices(rpc);
        const gaps = new SqliteSyncGapStore();
        const delivered: JobEnvelope[] = [];
        await startBackfillHandler(rpc, gaps, delivered);
        const scheduler = new SyncGapScheduler(services.registry, gaps, {
            chainId: F.ChainId,
            batchSize: F.BatchSize,
        });
        await scheduler.scan(F.Head);
        const batch = planSyncGapRepairBatches(
            gaps.listDueRepairsAtNewestPendingHeight({
                chainId: 1,
                now: Date.now(),
                limit: 16,
            }),
            F.BatchSize,
        )[0];
        await services.executor.runDue();
        await services.publishRetained(queue);
        await waitForFixture(
            () =>
                ids.every(
                    (id) => gaps.getProgress(F.ChainId, id)?.pending === null,
                ) && fanout.length === 6,
            "grouped repair and collection-scoped fanout",
        );
        expect(delivered).toHaveLength(0);
        expect(blockReads).toEqual([106, 107, 107]);
        expect(rpc.logReads).toBe(4);
        for (const id of ids) {
            expect(
                services.storage.countCollectionSyncedBlocksInRange(
                    F.ChainId,
                    id,
                    106,
                    107,
                ),
            ).toBe(2);
            expect(
                fanout
                    .filter((job) => job.collectionId === id)
                    .map((job) => job.kind)
                    .sort(),
            ).toEqual(
                [
                    DOMAIN_JOB_KIND.ActivitySync,
                    DOMAIN_JOB_KIND.OrdersSync,
                    DOMAIN_JOB_KIND.MetadataSync,
                ].sort(),
            );
        }
        expect(
            fanout.every(
                (job) =>
                    job.payload.sourceJobId ===
                    `${batch.repairs.find((r) => r.collectionId === job.collectionId)!.repairId}:range:${batch.fromBlock}-${batch.toBlock}`,
            ),
        ).toBe(true);
        expect(deadLetters).toHaveLength(0);
        await writeFile(
            path.join(artifacts, "grouped-gap-result.json"),
            JSON.stringify(
                { delivered, blockReads, logReads: rpc.logReads, fanout },
                null,
                2,
            ),
        );
    });

    it.each([
        BACKFILL_SOURCE.ManualHistorical,
        BACKFILL_SOURCE.BootstrapCatchup,
        "unknown",
    ])(
        "rejects %s batches through the production handler with retained and stale members",
        async (source) => {
            db.exec(
                "DELETE FROM collections; DELETE FROM blocks; DELETE FROM transactions;",
            );
            const ids = [1, 2, 3].map((number) =>
                insertCollection({
                    chainId: F.ChainId,
                    slug: `invalid-source-${number}`,
                    address: `0x${String(number).repeat(40)}`,
                    anchorBlock: F.Anchor,
                }),
            );
            const rpc = new RecoveryRpc();
            let blockReads = 0;
            rpc.beforeBlockRead = async () => {
                blockReads++;
            };
            services = reorgRecoveryServices(rpc);
            const gaps = new SqliteSyncGapStore();
            // Keep a third live collection fully covered and outside the members.
            services.storage.persistSyncResult({
                checkpoint: services.storage.captureSyncCheckpoint(F.ChainId),
                blocks: Array.from({ length: 8 }, (_, i) =>
                    canonicalRecoveryBlock(100 + i),
                ),
                data: emptyOnChainData(),
                collections: [
                    services.registry.getCollection(F.ChainId, ids[2])!,
                ],
            });
            const initialCoverage = ids.map((id) =>
                services.storage.countCollectionSyncedBlocksInRange(
                    F.ChainId,
                    id,
                    106,
                    107,
                ),
            );
            await new SyncGapScheduler(services.registry, gaps, {
                chainId: F.ChainId,
                batchSize: F.BatchSize,
            }).scan(F.Head);
            const batch = retainedGapJob(gaps);
            if (
                batch.payload.source !== BACKFILL_SOURCE.GapRepair ||
                !batch.payload.repairs
            )
                throw new Error("Missing retained batch fixture");
            expect(
                batch.payload.repairs.map((repair) => repair.collectionId),
            ).toEqual(ids.slice(0, 2));
            const delivered: JobEnvelope[] = [];
            await startBackfillHandler(rpc, gaps, delivered);
            for (const state of ["retained", "stale"]) {
                if (state === "stale") {
                    for (const repair of batch.payload.repairs)
                        gaps.recordRepairProgress({
                            chainId: F.ChainId,
                            repair,
                            remaining: null,
                            retryAt: Date.now(),
                        });
                }
                const before = ids.map((id) => gaps.getProgress(F.ChainId, id));
                const invalid = {
                    ...batch,
                    jobId: `invalid:${source}:${state}`,
                    payload: {
                        ...batch.payload,
                        source,
                        orderMaintenancePolicy:
                            source === BACKFILL_SOURCE.ManualHistorical
                                ? BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation
                                : BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                    },
                };
                await queue.publish(QUEUE_NAMES.BackfillSync, invalid);
                await waitForFixture(
                    () => delivered.some((job) => job.jobId === invalid.jobId),
                    "invalid delivery rejected",
                );
                expect(
                    ids.map((id) => gaps.getProgress(F.ChainId, id)),
                ).toEqual(before);
                expect(blockReads).toBe(0);
                expect(rpc.logReads).toBe(0);
                expect(fanout).toHaveLength(0);
                expect(
                    ids.map((id) =>
                        services.storage.countCollectionSyncedBlocksInRange(
                            F.ChainId,
                            id,
                            106,
                            107,
                        ),
                    ),
                ).toEqual(initialCoverage);
            }
            expect(deadLetters).toHaveLength(0);
        },
    );

    it.each([
        BACKFILL_SOURCE.ManualHistorical,
        BACKFILL_SOURCE.BootstrapCatchup,
    ])(
        "preserves valid %s global and collection-scoped delivery",
        async (source) => {
            const rpc = new RecoveryRpc();
            services = reorgRecoveryServices(rpc);
            const gaps = new SqliteSyncGapStore();
            const delivered: JobEnvelope[] = [];
            await startBackfillHandler(rpc, gaps, delivered);
            for (const scope of [undefined, collectionId]) {
                const job = {
                    jobId: `valid:${source}:${scope ?? "all"}`,
                    kind: SYNC_JOB_KIND.BackfillRange,
                    queue: QUEUE_NAMES.BackfillSync,
                    chainId: F.ChainId,
                    collectionId: scope,
                    scheduledAt: Date.now(),
                    attempt: 0,
                    payload: {
                        fromBlock: 106,
                        toBlock: 107,
                        source,
                        orderMaintenancePolicy:
                            source === BACKFILL_SOURCE.ManualHistorical
                                ? BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation
                                : BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                    },
                };
                await queue.publish(QUEUE_NAMES.BackfillSync, job);
                await waitForFixture(
                    () =>
                        delivered.some((entry) => entry.jobId === job.jobId) &&
                        fanout.filter(
                            (entry) => entry.payload.sourceJobId === job.jobId,
                        ).length === 3,
                    "valid ordinary backfill fanout",
                );
                const produced = fanout.filter(
                    (entry) => entry.payload.sourceJobId === job.jobId,
                );
                expect(produced.map((entry) => entry.collectionId)).toEqual([
                    scope,
                    scope,
                    scope,
                ]);
            }
            expect(rpc.logReads).toBe(8);
            expect(deadLetters).toHaveLength(0);
        },
    );

    function retainedGapJob(
        gaps: SqliteSyncGapStore,
    ): JobEnvelope<BackfillSyncPayload> {
        const batch = planSyncGapRepairBatches(
            gaps.listDueRepairsAtNewestPendingHeight({
                chainId: 1,
                now: Date.now(),
                limit: 16,
            }),
            F.BatchSize,
        )[0];
        return {
            jobId: "legacy-gap-batch",
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            chainId: 1,
            attempt: 0,
            scheduledAt: 0,
            payload: {
                ...batch,
                source: BACKFILL_SOURCE.GapRepair,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            },
        };
    }

    it("ACKs legacy scoped gap hints without acquisition, then executes their durable owner", async () => {
        const rpc = new RecoveryRpc();
        services = reorgRecoveryServices(rpc);
        const gaps = services.gaps;
        await new SyncGapScheduler(services.registry, gaps, {
            chainId: 1,
            batchSize: F.BatchSize,
        }).scan(F.Head);
        const batch = retainedGapJob(gaps);
        if (batch.payload.source !== BACKFILL_SOURCE.GapRepair)
            throw new Error("Invalid gap fixture");
        const target = batch.payload.repairs![0],
            legacy = {
                ...batch,
                jobId: target.repairId,
                collectionId: target.collectionId,
                payload: { ...batch.payload, repairs: undefined },
            };
        const delivered: JobEnvelope[] = [];
        await startBackfillHandler(rpc, gaps, delivered);
        await queue.publish(QUEUE_NAMES.BackfillSync, legacy);
        await waitForFixture(
            () => delivered.length === 1,
            "legacy hint acknowledged",
        );
        expect(rpc.logReads).toBe(0);
        expect(
            gaps.getProgress(1, target.collectionId)?.pending?.repairId,
        ).toBe(target.repairId);
        await services.executor.runDue();
        await services.publishRetained(queue);
        await waitForFixture(() => fanout.length === 3, "direct repair fanout");
        expect(gaps.getProgress(1, target.collectionId)?.pending).toBeNull();
        expect(
            fanout.every((j) => j.collectionId === target.collectionId),
        ).toBe(true);
    });

    it("ACKs obsolete reorg range hints and completes managed acquisition directly", async () => {
        const rpc = new RecoveryRpc();
        services = reorgRecoveryServices(rpc);
        await services.recovery.checkBlock(F.Orphan);
        const first = pendingRecoveryRange();
        const delivered: JobEnvelope[] = [];
        await startBackfillHandler(rpc, services.gaps, delivered);
        await queue.publish(QUEUE_NAMES.BackfillSync, {
            jobId: "old-reorg-delivery",
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            chainId: 1,
            attempt: 0,
            scheduledAt: 0,
            payload: {
                fromBlock: first.fromBlock,
                toBlock: first.toBlock,
                source: BACKFILL_SOURCE.ReorgRecovery,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                recovery: {
                    recoveryId: first.recoveryId,
                    revision: first.revision,
                },
            },
        });
        await waitForFixture(
            () => delivered.length === 1,
            "old reorg hint acknowledged",
        );
        expect(rpc.logReads).toBe(0);
        expect(pendingRecoveryRange()).toEqual(first);
        while (services.recoveries.getRecovery(1))
            await services.executor.runDue();
        await services.publishRetained(queue);
        await waitForFixture(
            () => fanout.length === 6,
            "required reorg fanout",
        );
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: F.Owner, amount: "1" },
        ]);
        expect(deadLetters).toHaveLength(0);
    });

    async function startBackfillHandler(
        rpc: RecoveryRpc,
        gaps: SqliteSyncGapStore,
        delivered: JobEnvelope[],
    ) {
        stops.push(
            startQueueOutboxDrainer(services.outbox, queue, {
                pollMs: 20,
                retryBaseDelayMs: 20,
            }),
        );
        const handle = createBackfillSyncHandler({
            chainId: F.ChainId,
            workerCount: 1,
            wethAddress: F.Weth,
            rpc,
            storage: services.storage,
            commit: services.commit,
            collectionsPort: services.registry,
            extensions: { getInstall: () => null },
            bidderIndex: { isActive: () => false, shouldEmit: () => false },
            gate: new BackfillExecutionGate(),
        });
        stops.push(
            await runWorker(
                queue,
                {
                    queue: QUEUE_NAMES.BackfillSync,
                    consumerName: "fixture-backfill",
                    maxInFlight: 1,
                    maxAttempts: 5,
                    deadLetterQueue: QUEUE_NAMES.DeadLetter,
                },
                async (job) => {
                    await handle(job);
                    delivered.push(job);
                },
            ),
        );
    }

    async function worker(overrides: Partial<ReorgFixtureConfig> = {}) {
        const config: ReorgFixtureConfig = {
            dbPath,
            natsUrl: broker.url,
            prefix,
            role: ROLE.All,
            publication: PUBLICATION.Healthy,
            retryDelayMs: 300,
            ackWaitMs: 150,
            extendLeaseMs: 25,
            resume: true,
            publish: true,
            ...overrides,
        };
        const configPath = path.join(artifacts, `worker-${++childNumber}.json`);
        await writeFile(configPath, JSON.stringify(config));
        const child = spawn(process.execPath, [workerArtifact, configPath], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            env: { ...process.env, ARTGOD_WORKSPACE_ROOT: root },
        });
        children.add(child);
        const outputFile = createWriteStream(
            path.join(artifacts, `worker-${childNumber}.log`),
        );
        let output = "";
        for (const stream of [child.stdout!, child.stderr!])
            stream.on("data", (chunk) => {
                outputFile.write(chunk);
                output = (output + String(chunk)).slice(-6_000);
            });
        child.on("exit", () => outputFile.end());
        const ownReports: ReorgFixtureReport[] = [];
        child.on("message", (message) => {
            ownReports.push(message as ReorgFixtureReport);
            reports.push(message as ReorgFixtureReport);
        });
        const wait = (check: () => boolean, label: string) =>
            waitForFixture(() => {
                if (child.exitCode !== null || child.signalCode !== null)
                    throw new Error(
                        `Fixture exited during ${label}: ${output}`,
                    );
                return check();
            }, label);
        await wait(
            () =>
                ownReports.some(
                    (r) =>
                        r.phase ===
                        (config.role === ROLE.Writer
                            ? PHASE.WriterLocked
                            : PHASE.Ready),
                ),
            "fixture startup",
        );
        return {
            child,
            reports: ownReports,
            wait,
            async kill() {
                await stopFixtureChild(child, "SIGKILL");
                children.delete(child);
            },
            async stop() {
                child.send(COMMAND.Stop);
                await waitForFixture(
                    () => child.exitCode !== null || child.signalCode !== null,
                    "graceful fixture stop",
                );
                expect(child.exitCode, output).toBe(0);
                children.delete(child);
            },
        };
    }
    async function publishCheck(id = "check-105") {
        await queue.publish(QUEUE_NAMES.BlockCheck, {
            jobId: id,
            kind: REORG_JOB_KIND.BlockCheck,
            queue: QUEUE_NAMES.BlockCheck,
            chainId: 1,
            attempt: 0,
            scheduledAt: Date.now(),
            payload: { blockNumber: F.Orphan },
        });
    }
    function revision() {
        return services.storage.captureSyncCheckpoint(1).revision;
    }
    function owners() {
        return selectBalanceOwners(1, collectionId, "1");
    }
    async function restartedBroker() {
        for (const stop of stops.splice(0)) await stop();
        await queue.close();
        await broker.stop();
        setDbPath(dbPath);
        services = reorgRecoveryServices(new RecoveryRpc(), {
            retryDelayMs: 300,
        });
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "jetstream"),
        );
        await connect();
    }
    async function complete() {
        await waitForFixture(
            () =>
                services.recoveries.getRecovery(1) === null && revision() === 1,
            "recovery completion",
        );
        const manager = await broker.connection.jetstreamManager();
        await waitForFixture(async () => {
            const consumer = await manager.consumers.info(
                resolveNatsJobStreamName(prefix),
                CONSUMER.Resync,
            );
            return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
        }, "resync acknowledgements");
        expect(owners()).toEqual([{ owner: F.Owner, amount: "1" }]);
        expect(selectTransferCount(1, collectionId, "1")).toBe(0);
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                collectionId,
                105,
                107,
            ),
        ).toBe(3);
        await waitForFixture(
            () =>
                fanout.some(
                    (j) =>
                        j.queue === QUEUE_NAMES.MetadataDomain &&
                        j.payload.fromBlock === 107,
                ),
            "final required fanout",
        );
    }

    it("resumes atomic rollback after process death before publication and a broker restart", async () => {
        const first = await worker({
            role: ROLE.Reorg,
            publish: false,
            resume: false,
        });
        await publishCheck();
        await first.wait(
            () => first.reports.some((r) => r.phase === PHASE.Acknowledged),
            "retained check acknowledged",
        );
        expect(revision()).toBe(1);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        await first.kill();
        await restartedBroker();
        const resumed = await worker();
        await complete();
        await resumed.stop();
        expect(revision()).toBe(1);
    });

    it("keeps the only recovery owner on the broker beyond retry limits when initial journal persistence fails", async () => {
        db.exec(
            "CREATE TRIGGER fail_mismatch_retention BEFORE INSERT ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;",
        );
        const retained = await worker();
        await publishCheck();
        await retained.wait(
            () =>
                retained.reports.some(
                    (r) => r.phase === PHASE.Deferred && (r.attempt ?? 0) > 2,
                ),
            "retention retries exceed ordinary DLQ limit",
        );
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(deadLetters).toHaveLength(0);
        expect(revision()).toBe(0);
        db.exec("DROP TRIGGER fail_mismatch_retention;");
        await complete();
        await retained.stop();
    });

    it("keeps broker ownership when an RPC failure follows journal deferrals beyond the production retry budget", async () => {
        db.exec(
            "CREATE TEMP TRIGGER fail_mismatch_retention BEFORE INSERT ON chain_reorg_recoveries BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;",
        );
        const rpc = new RecoveryRpc();
        services = reorgRecoveryServices(rpc, { retryDelayMs: 20 });
        const deliveries: number[] = [];
        let releaseSeventh!: () => void;
        const seventhGate = new Promise<void>((resolve) => {
            releaseSeventh = resolve;
        });
        stops.push(
            await runWorker(
                queue,
                {
                    queue: QUEUE_NAMES.BlockCheck,
                    consumerName: CONSUMER.Reorg,
                    maxInFlight: 1,
                    ackWaitMs: 150,
                    extendLeaseMs: 25,
                    maxAttempts: 5,
                    deadLetterQueue: QUEUE_NAMES.DeadLetter,
                },
                async (job: JobEnvelope<BlockCheckPayload>) => {
                    const attempt = job.attempt!;
                    deliveries.push(attempt);
                    if (attempt === 6) {
                        db.exec("DROP TRIGGER fail_mismatch_retention;");
                        rpc.beforeBlockRead = async () => {
                            rpc.beforeBlockRead = undefined;
                            throw new Error(
                                "Temporary RPC outage after journal recovery",
                            );
                        };
                    }
                    if (attempt === 7) await seventhGate;
                    await services.recovery.checkBlock(job.payload.blockNumber);
                },
            ),
        );
        await publishCheck("retention-followup-check");
        const manager = await broker.connection.jetstreamManager();
        try {
            await waitForFixture(
                () => deliveries.includes(7),
                "the original check survives its sixth-delivery RPC failure",
            );
            expect(deliveries).toEqual([1, 2, 3, 4, 5, 6, 7]);
            expect(deadLetters).toHaveLength(0);
            expect(services.recoveries.getRecovery(F.ChainId)).toBeNull();
            expect(revision()).toBe(0);
            const consumer = await manager.consumers.info(
                resolveNatsJobStreamName(prefix),
                CONSUMER.Reorg,
            );
            expect(consumer.num_ack_pending).toBe(1);
        } finally {
            releaseSeventh();
        }
        await waitForFixture(
            () =>
                services.recoveries.getRecovery(F.ChainId)?.phase ===
                REORG_RECOVERY_PHASE.Resync,
            "healthy delivery retains and rolls back recovery",
        );
        const resumed = await worker({ role: ROLE.Resync });
        await complete();
        await waitForFixture(async () => {
            const consumer = await manager.consumers.info(
                resolveNatsJobStreamName(prefix),
                CONSUMER.Reorg,
            );
            return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
        }, "the handed-off check is acknowledged");
        expect(deadLetters).toHaveLength(0);
        await writeFile(
            path.join(artifacts, "retention-followup-result.json"),
            JSON.stringify(
                {
                    deliveries,
                    deadLetters: deadLetters.length,
                    recovery: services.recoveries.getRecovery(F.ChainId),
                    revision: revision(),
                    owners: owners(),
                },
                null,
                2,
            ),
        );
        await resumed.stop();
    });

    it("retries acquisition after process death during RPC with intent and progress unchanged", async () => {
        await services.recovery.checkBlock(F.Orphan);
        const retained = pendingRecoveryRange();
        const interrupted = await worker({
            role: ROLE.Resync,
            resume: false,
            publish: false,
            holdAcquisition: true,
        });
        await interrupted.wait(
            () =>
                interrupted.reports.some(
                    (r) => r.phase === PHASE.AcquisitionHeld,
                ),
            "acquisition held before commit",
        );
        expect(pendingRecoveryRange()).toEqual(retained);
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                collectionId,
                105,
                106,
            ),
        ).toBe(0);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        await interrupted.kill();
        await restartedBroker();
        const resumed = await worker();
        await complete();
        await resumed.stop();
    });

    it("publishes retained follow-ups after process death without reacquiring recovery ranges", async () => {
        await services.recovery.checkBlock(F.Orphan);
        const acquired = await worker({
            role: ROLE.Resync,
            resume: false,
            publish: false,
        });
        await acquired.wait(
            () => services.recoveries.getRecovery(1) === null,
            "acquisition complete before publication",
        );
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM queue_outbox WHERE status = ? AND json_extract(job_json, '$.workClass') = ?",
                )
                .get(QUEUE_OUTBOX_STATUS.Pending, SYNC_WORK_CLASS.Main),
        ).toEqual({ count: 6 });
        await acquired.kill();
        await restartedBroker();
        const resumed = await worker();
        await complete();
        expect(
            resumed.reports.filter((r) => r.phase === PHASE.Resynced),
        ).toEqual([]);
        await resumed.stop();
    });

    it("replays partial fanout after coverage, process death and broker restart", async () => {
        await services.recovery.checkBlock(F.Orphan);
        const first = await worker({
            role: ROLE.Resync,
            resume: false,
            publication: PUBLICATION.HoldMetadata,
        });
        await first.wait(
            () => first.reports.some((r) => r.phase === PHASE.FanoutHeld),
            "metadata fanout held",
        );
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                collectionId,
                105,
                106,
            ),
        ).toBe(2);
        const retained = services.recoveries.getRecovery(1);
        expect(
            retained === null ||
                (retained.phase === REORG_RECOVERY_PHASE.Resync &&
                    retained.fromBlock >= 107),
        ).toBe(true);
        expect(
            (
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM queue_outbox WHERE queue_name = ? AND status = ?",
                    )
                    .get(
                        QUEUE_NAMES.MetadataDomain,
                        QUEUE_OUTBOX_STATUS.Pending,
                    ) as { count: number }
            ).count,
        ).toBeGreaterThan(0);
        await first.kill();
        await restartedBroker();
        const resumed = await worker();
        await complete();
        await resumed.stop();
        expect(
            fanout.some(
                (j) =>
                    j.queue === QUEUE_NAMES.MetadataDomain &&
                    j.payload.fromBlock === 105,
            ),
        ).toBe(true);
    });

    it("retries required publications with a lost broker reply using the same deduplication identity", async () => {
        await services.recovery.checkBlock(F.Orphan);
        while (services.recoveries.getRecovery(1))
            await services.executor.runDue();
        const first = services.outbox
            .listDue(Date.now(), 10)
            .map((r) => JSON.parse(r.jobJson) as JobEnvelope)
            .find((j) => j.queue === QUEUE_NAMES.MetadataDomain)!;
        const publisher = await worker({
            role: ROLE.Publisher,
            resume: false,
            publication: PUBLICATION.Ambiguous,
        });
        await publisher.wait(
            () =>
                publisher.reports.some(
                    (r) =>
                        r.phase === PHASE.AmbiguousPublication &&
                        r.jobId === first.jobId,
                ),
            "broker reply lost after acceptance",
        );
        await waitForFixture(
            () =>
                !db
                    .prepare(
                        "SELECT outbox_id FROM queue_outbox WHERE job_id = ?",
                    )
                    .get(first.jobId),
            "required publication accepted and removed",
        );
        await waitForFixture(
            () => fanout.length === 6,
            "all required publications delivered",
        );
        await publisher.stop();
        const before = fanout.length;
        await queue.publish(QUEUE_NAMES.MetadataDomain, first);
        await delay(100);
        expect(fanout).toHaveLength(before);
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(deadLetters).toHaveLength(0);
    });

    it("keeps required fanout beyond ordinary retry limits and recovers after broker restart", async () => {
        await services.recovery.checkBlock(F.Orphan);
        const failing = await worker({
            role: ROLE.Resync,
            resume: false,
            publication: PUBLICATION.FailMetadata,
        });
        await waitForFixture(() => {
            const rows = db
                .prepare(
                    "SELECT status, attempts FROM queue_outbox WHERE queue_name = ? AND json_extract(job_json, '$.workClass') = ?",
                )
                .all(QUEUE_NAMES.MetadataDomain, SYNC_WORK_CLASS.Main) as {
                status: string;
                attempts: number;
            }[];
            return (
                services.recoveries.getRecovery(1) === null &&
                rows.length === 2 &&
                rows.every(
                    (r) =>
                        r.status === QUEUE_OUTBOX_STATUS.FailedRetry &&
                        r.attempts >= 6,
                )
            );
        }, "required publication remains retryable beyond budget");
        expect(deadLetters).toHaveLength(0);
        await failing.stop();
        await restartedBroker();
        const resumed = await worker();
        await complete();
        expect(
            resumed.reports.filter((r) => r.phase === PHASE.Resynced),
        ).toEqual([]);
        await resumed.stop();
    });

    it("renews a real reorg lease while exact-block ownership takes longer than ackWait", async () => {
        const delayed = await worker({
            role: ROLE.Reorg,
            resume: false,
            publish: false,
            ownerDelayMs: 550,
        });
        await publishCheck();
        await delayed.wait(
            () => delayed.reports.some((r) => r.phase === PHASE.Acknowledged),
            "delayed recovery acknowledged",
        );
        const manager = await broker.connection.jetstreamManager();
        const consumer = await manager.consumers.info(
            resolveNatsJobStreamName(prefix),
            CONSUMER.Reorg,
        );
        expect(consumer.num_redelivered).toBe(0);
        expect(
            delayed.reports.filter((r) => r.phase === PHASE.Touch).length,
        ).toBeGreaterThan(3);
        expect(
            delayed.reports.filter((r) => r.phase === PHASE.Checked),
        ).toEqual([
            expect.objectContaining({ ownerReads: 1, revision: 1, attempt: 1 }),
        ]);
        await delayed.stop();
    });

    it("remains idempotent under forced check redelivery and a lost obsolete hint ACK", async () => {
        const delayed = await worker({
            role: ROLE.Reorg,
            resume: false,
            publish: false,
            extendLeaseMs: 0,
            ownerDelayMs: 550,
        });
        await publishCheck();
        await delayed.wait(
            () =>
                delayed.reports.filter((r) => r.phase === PHASE.Checked)
                    .length >= 2,
            "forced check redelivery",
        );
        expect(revision()).toBe(1);
        expect(
            delayed.reports
                .filter((r) => r.phase === PHASE.Checked)
                .every((r) => r.ownerReads === 1),
        ).toBe(true);
        expect(delayed.reports.some((r) => (r.attempt ?? 0) > 1)).toBe(true);
        await delayed.stop();
        const retainedRecoveryId = pendingRecoveryRange().recoveryId;
        const resumed = await worker({ dropAckOnce: true });
        await queue.publish(QUEUE_NAMES.BackfillSync, {
            jobId: "old-automatic-hint",
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            chainId: 1,
            attempt: 0,
            scheduledAt: 0,
            payload: {
                fromBlock: 105,
                toBlock: 106,
                source: BACKFILL_SOURCE.ReorgRecovery,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                recovery: {
                    recoveryId: retainedRecoveryId,
                    revision: 1,
                },
            },
        });
        await resumed.wait(
            () =>
                resumed.reports.some(
                    (r) =>
                        r.phase === PHASE.Acknowledged &&
                        r.jobId === "old-automatic-hint" &&
                        (r.attempt ?? 0) > 1,
                ),
            "obsolete hint redelivery acknowledged",
        );
        await complete();
        await resumed.stop();
    });

    it("retains the lease and bounded continuation for a larger serial ownership snapshot", async () => {
        const collection = services.registry.getCollection(1, collectionId)!;
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = Array.from(
            { length: 400 },
            (_, i) => ({
                collectionId,
                contract: collection.address,
                tokenId: String(i + 2),
                from: F.Owner,
                to: F.OrphanOwner,
                amount: "1",
                kind: COLLECTION_STANDARD.Erc721,
                blockNumber: F.Orphan,
                blockHash: syncBlockFixture(F.Orphan).hash,
                txHash: syncBlockFixture(F.Orphan).hash,
                logIndex: i + 2,
            }),
        );
        services.storage.persistSyncResult({
            checkpoint: services.storage.captureSyncCheckpoint(1),
            blocks: [syncBlockFixture(F.Orphan)],
            collections: [collection],
            data,
        });
        const snapshot = await worker({
            role: ROLE.Reorg,
            resume: false,
            publish: false,
            ownerDelayMs: 5,
        });
        await publishCheck();
        await snapshot.wait(
            () => snapshot.reports.some((r) => r.phase === PHASE.Acknowledged),
            "serial ownership snapshot completion",
        );
        const result = snapshot.reports.find((r) => r.phase === PHASE.Checked)!;
        expect(result.ownerReads).toBe(401);
        expect(result.revision).toBe(1);
        expect(result.elapsedMs).toBeGreaterThan(2_000);
        expect(result.rssBytes).toBeGreaterThan(0);
        expect(
            snapshot.reports.filter((r) => r.phase === PHASE.Touch).length,
        ).toBeGreaterThan(20);
        expect(
            (
                await (
                    await broker.connection.jetstreamManager()
                ).consumers.info(
                    resolveNatsJobStreamName(prefix),
                    CONSUMER.Reorg,
                )
            ).num_redelivered,
        ).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM nft_balances WHERE collection_id = ? AND owner = ?",
                )
                .get(collectionId, F.Owner),
        ).toEqual({ count: 401 });
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 105,
            toBlock: 106,
        });
        await snapshot.stop();
    });

    it("retries atomic rollback under a competing SQLite writer process", async () => {
        const checking = await worker({
            role: ROLE.Reorg,
            resume: false,
            publish: false,
            holdOwner: true,
            sqliteBusyTimeoutMs: 80,
        });
        await publishCheck();
        await checking.wait(
            () => checking.reports.some((r) => r.phase === PHASE.RpcHeld),
            "snapshot held before writer contention",
        );
        const writer = await worker({ role: ROLE.Writer, writerHoldMs: 250 });
        checking.child.send(COMMAND.ReleaseRpc);
        await checking.wait(
            () => checking.reports.some((r) => r.phase === PHASE.Acknowledged),
            "rollback after bounded SQLite retry",
        );
        const result = checking.reports.find((r) => r.phase === PHASE.Checked)!;
        expect(result.revision).toBe(1);
        expect(result.elapsedMs).toBeGreaterThan(160); // One 80ms busy wait cannot succeed under this held writer.
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 105,
            toBlock: 106,
        });
        await waitForFixture(
            () => writer.child.exitCode === 0,
            "competing writer release",
        );
        children.delete(writer.child);
        await checking.stop();
    });

    it("rejects stale rollback prepared in one process after another commits the recovery", async () => {
        const first = await worker({
            role: ROLE.Reorg,
            resume: false,
            publish: false,
            holdOwner: true,
        });
        await publishCheck();
        await first.wait(
            () => first.reports.some((r) => r.phase === PHASE.RpcHeld),
            "first process snapshot held",
        );
        const competitor = await worker({
            role: ROLE.Direct,
            resume: false,
            publish: false,
        });
        competitor.child.send(COMMAND.Check);
        await competitor.wait(
            () => competitor.reports.some((r) => r.phase === PHASE.Checked),
            "competing process commits rollback",
        );
        expect(revision()).toBe(1);
        const retainedRange = pendingRecoveryRange();
        first.child.send(COMMAND.ReleaseRpc);
        await first.wait(
            () => first.reports.some((r) => r.phase === PHASE.Acknowledged),
            "stale process safely finishes",
        );
        expect(revision()).toBe(1);
        expect(pendingRecoveryRange()).toEqual(retainedRange);
        expect(owners()).toEqual([{ owner: F.Owner, amount: "1" }]);
        await competitor.stop();
        await first.stop();
    });
});
