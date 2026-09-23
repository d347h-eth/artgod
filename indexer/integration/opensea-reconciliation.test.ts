// Real-broker regression using disposable stores under this worktree's tmp/.
// Uses an already provisioned project NATS binary; never connects to the live broker.
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";
import { parseRequiredString } from "@artgod/shared/utils/env";
import { setTimeout as delay } from "node:timers/promises";
import {
    connect,
    consumerOpts,
    createInbox,
    nanos,
    type NatsConnection,
} from "nats";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
} from "@artgod/shared/types";
import {
    resolveNatsJobStreamName,
    resolveNatsJobSubject,
} from "@artgod/shared/queue/nats-job-stream";
import { DEFAULT_DESKTOP_NATS_VERSION } from "../../scripts/build/native-runtime-dependencies.mjs";
import { runWorker } from "../src/application/worker-runner.js";
import { handleReconcileJob } from "../src/application/offchain/opensea-reconcile.js";
import { OpenSeaOrderbookSync } from "../src/application/offchain/opensea-orderbook-sync.js";
import { OpenSeaReconcilePolicy } from "../src/domain/opensea-reconcile-policy.js";
import { OPENSEA_RECONCILE_WORKER_POLICY } from "../src/config/opensea-reconcile-worker.js";
import {
    OPENSEA_JOB_KIND,
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_QUEUE_NAME,
    OPENSEA_RECONCILE_REASON as REASON,
    type OpenSeaReconcileReason,
    type OpenSeaReconcileCollectionPayload,
} from "../src/domain/opensea-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteOpenSeaOrderbookRuns } from "../src/infra/offchain/sqlite-orderbook-runs.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";

it("renews leases, drains obsolete work and recovers an interrupted durable on real NATS", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const binary = parseRequiredString(
        process.env.OPENSEA_RECONCILE_TEST_NATS_BINARY,
        "OPENSEA_RECONCILE_TEST_NATS_BINARY",
    );
    const version = (
        await promisify(execFile)(binary, ["--version"])
    ).stdout.trim();
    assert(
        version.includes(DEFAULT_DESKTOP_NATS_VERSION),
        "Fixture requires the project's pinned NATS version",
    );
    const artifactRoot = path.join(root, "tmp/opensea-reconcile-nats");
    await mkdir(artifactRoot, { recursive: true });
    const artifacts = await mkdtemp(path.join(artifactRoot, "run-"));
    const store = path.join(artifacts, "store");
    const policy = {
        ...OPENSEA_RECONCILE_WORKER_POLICY,
        ackWaitMs: OPENSEA_RECONCILE_WORKER_POLICY.ackWaitMs / 60,
        extendLeaseMs: Math.floor(
            OPENSEA_RECONCILE_WORKER_POLICY.extendLeaseMs / 60,
        ),
    };
    const scanMs = policy.ackWaitMs * 4 + 100;
    const consumerName = "reconcile-fixture";
    const results: Record<string, unknown> = { version, policy, scanMs };
    const queues = new Set<NatsJetStreamQueue>();

    function job(
        id: number,
        suffix: string,
        reason: OpenSeaReconcileReason = REASON.Scheduled,
    ): JobEnvelope<OpenSeaReconcileCollectionPayload> {
        return {
            jobId: `${OPENSEA_JOB_ID_SCOPE.ReconcileCollection}:1:${id}:${reason}:${suffix}`,
            kind: OPENSEA_JOB_KIND.ReconcileCollection,
            queue: OPENSEA_QUEUE_NAME.Reconcile,
            payload: { chainId: 1, collectionId: id, reason },
            chainId: 1,
            collectionId: id,
            attempt: 0,
            scheduledAt: 0,
        };
    }
    function gate() {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    }
    async function until(
        predicate: () => boolean | Promise<boolean>,
        label: string,
        timeoutMs = 30_000,
    ) {
        const deadline = Date.now() + timeoutMs;
        while (!(await predicate())) {
            if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
            await delay(25);
        }
    }
    async function queueFor(broker: Broker, prefix: string) {
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: broker.url,
            streamPrefix: prefix,
        });
        queues.add(queue);
        return queue;
    }
    async function closeQueue(queue: NatsJetStreamQueue) {
        await queue.close();
        queues.delete(queue);
    }
    async function info(broker: Broker, prefix: string) {
        return broker.manager.consumers.info(
            resolveNatsJobStreamName(prefix),
            consumerName,
        );
    }
    async function drained(broker: Broker, prefix: string) {
        await until(async () => {
            const state = await info(broker, prefix);
            return state.num_pending === 0 && state.num_ack_pending === 0;
        }, `drain ${prefix}`);
    }

    async function verifyDelivery(broker: Broker, renew: boolean) {
        const prefix = renew
            ? "reconcile-renewal-fixture"
            : "reconcile-control-fixture";
        const queue = await queueFor(broker, prefix);
        // Create a persisted push durable with stale settings, then restart through
        // the production adapter's consumer-config reconciliation path.
        const options = consumerOpts();
        options.durable(consumerName);
        options.manualAck();
        options.ackExplicit();
        options.deliverTo(createInbox());
        options.deliverAll();
        const subject = resolveNatsJobSubject(
            prefix,
            OPENSEA_QUEUE_NAME.Reconcile,
        );
        options.filterSubject(subject);
        options.ackWait(policy.ackWaitMs * 2);
        options.maxAckPending(5);
        const initial = await broker.connection
            .jetstream()
            .subscribe(subject, options);
        await initial.drain();
        const release = gate();
        let calls = 0;
        const stop = await runWorker(
            queue,
            {
                queue: OPENSEA_QUEUE_NAME.Reconcile,
                consumerName,
                ...policy,
                extendLeaseMs: renew ? policy.extendLeaseMs : undefined,
            },
            async () => {
                calls++;
                await release.promise;
            },
        );
        let stopping: Promise<void> | undefined;
        try {
            const configured = await info(broker, prefix);
            assert.equal(configured.config.ack_wait, nanos(policy.ackWaitMs));
            assert.equal(configured.config.max_ack_pending, policy.maxInFlight);
            await queue.publish(OPENSEA_QUEUE_NAME.Reconcile, job(99, prefix));
            await until(() => calls === 1, "slow handler starts");
            await delay(scanMs);
            const during = await info(broker, prefix);
            if (renew) {
                assert.equal(during.num_redelivered, 0);
                assert.equal(during.delivered.consumer_seq, 1);
            } else {
                assert(
                    during.num_redelivered > 0,
                    "Control must reproduce broker redelivery",
                );
                assert(during.delivered.consumer_seq > 1);
            }
            // Graceful stop must wait for active work while its lease stays alive.
            let stopped = false;
            stopping = stop().then(() => {
                stopped = true;
            });
            await delay(policy.ackWaitMs * 2);
            assert.equal(stopped, false);
            if (renew)
                assert.equal((await info(broker, prefix)).num_redelivered, 0);
            release.resolve();
            await stopping;
            await drained(broker, prefix);
            if (renew) assert.equal(calls, 1);
            else
                assert(
                    calls > 1,
                    "Locally queued copies must reproduce repeated work",
                );
            results[renew ? "renewedDelivery" : "unrenewedControl"] = {
                calls,
                brokerDeliveriesDuringScan: during.delivered.consumer_seq,
                redeliveredDuringScan: during.num_redelivered,
                ackWaitNanos: configured.config.ack_wait,
                gracefulStopWaited: true,
            };
        } finally {
            release.resolve();
            await (stopping ?? stop());
            await closeQueue(queue);
        }
    }

    async function verifyBacklog(broker: Broker) {
        setDbPath(path.join(artifacts, "fixture.sqlite"));
        await createMigrationRunner().runMigrations();
        const counts = [92, 65, 64, 64, 64, 64, 64, 64];
        for (let id = 101; id <= 108; id++) {
            db.prepare(
                `INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug,opensea_status)
            VALUES (?,1,?,?,'erc721',?,'contract_all_tokens',?,?)`,
            ).run(
                id,
                `fixture-${id}`,
                `contract-${id}`,
                COLLECTION_STATUS.Live,
                `fixture-${id}`,
                OPENSEA_COLLECTION_STATUS.Ready,
            );
        }
        const prefix = "reconcile-backlog-fixture";
        const queue = await queueFor(broker, prefix);
        const reasons = [REASON.Scheduled, REASON.StartupStale, REASON.Retry];
        for (let index = 0; index < counts.length; index++) {
            for (let i = 0; i < counts[index]; i++)
                await queue.publish(
                    OPENSEA_QUEUE_NAME.Reconcile,
                    job(101 + index, String(i), reasons[i % reasons.length]),
                );
        }
        const calls: number[] = [];
        const rawPublished: string[] = [];
        type Api = ConstructorParameters<typeof OpenSeaOrderbookSync>[0];
        const api: Api = {
            async forEachListing(slug, _address, receive) {
                const id = Number(slug.split("-")[1]);
                calls.push(id);
                await delay(scanMs / 2);
                await receive({
                    eventType: "fixture-listing",
                    orderId: `listing-${id}`,
                    sourceEventAt: null,
                    payload: {},
                });
            },
            async forEachOffer(slug, _address, receive) {
                await delay(scanMs / 2);
                await receive({
                    eventType: "fixture-offer",
                    orderId: `offer-${slug}`,
                    sourceEventAt: null,
                    payload: {},
                });
            },
        };
        const sync = new OpenSeaOrderbookSync(
            api,
            {
                async publish(destination, envelope) {
                    rawPublished.push(envelope.jobId);
                    await queue.publish(destination, envelope);
                },
            },
            new SqliteOrderSourceStateStore({ refreshSeller: () => {} }),
        );
        const collections = new SqliteCollectionRegistry();
        const runs = new SqliteOpenSeaOrderbookRuns();
        const freshness = new OpenSeaReconcilePolicy({
            reconcileIntervalMs: 15 * 60_000,
            staleStartThresholdMs: 30 * 60_000,
        });
        let deliveries = 0;
        const startedAt = Date.now();
        const stop = await runWorker<OpenSeaReconcileCollectionPayload>(
            queue,
            {
                queue: OPENSEA_QUEUE_NAME.Reconcile,
                consumerName,
                ...policy,
            },
            async (envelope) => {
                deliveries++;
                await handleReconcileJob(
                    queue,
                    collections,
                    runs,
                    sync,
                    freshness,
                    { baseDelayMs: 100, maxDelayMs: 1000 },
                    envelope,
                );
            },
        );
        try {
            await drained(broker, prefix);
            const state = await info(broker, prefix);
            assert.deepEqual(calls, [101, 102, 103, 104, 105, 106, 107, 108]);
            assert.equal(deliveries, 541);
            assert.equal(state.delivered.consumer_seq, 541);
            assert.equal(rawPublished.length, 16);
            assert.deepEqual(
                db
                    .prepare(
                        "SELECT status, count(*) AS count FROM opensea_orderbook_runs GROUP BY status",
                    )
                    .all(),
                [{ status: "completed", count: 8 }],
            );
            assert.equal(
                (
                    db
                        .prepare(
                            "SELECT count(*) AS n FROM market_order_observations",
                        )
                        .get() as { n: number }
                ).n,
                8,
            );
            const elapsedMs = Date.now() - startedAt;
            assert(
                elapsedMs < 30_000,
                "Backlog must drain faster than either production scheduling threshold",
            );
            results.backlog = {
                envelopes: 541,
                deliveries,
                usefulScans: calls.length,
                acknowledgedSkips: 533,
                rawPublished: rawPublished.length,
                elapsedMs,
                ...stateCounts(state),
            };
        } finally {
            await stop();
            await closeQueue(queue);
        }
    }

    function stateCounts(state: Awaited<ReturnType<typeof info>>) {
        return {
            pending: state.num_pending,
            ackPending: state.num_ack_pending,
            redelivered: state.num_redelivered,
        };
    }

    async function interruptWork(broker: Broker) {
        const prefix = "reconcile-interruption-fixture";
        const queue = await queueFor(broker, prefix);
        db.prepare(
            `INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug,opensea_status)
            VALUES (109,1,'interrupted','interrupted-contract','erc721',?,'contract_all_tokens','interrupted',?)`,
        ).run(COLLECTION_STATUS.Live, OPENSEA_COLLECTION_STATUS.Ready);
        const release = gate();
        let started = false;
        const sync = new OpenSeaOrderbookSync(
            {
                async forEachListing() {
                    started = true;
                    await release.promise;
                    throw new Error("fixture interrupted");
                },
                async forEachOffer() {
                    assert.fail("Interrupted listings cannot complete offers");
                },
            },
            queue,
            new SqliteOrderSourceStateStore({ refreshSeller: () => {} }),
        );
        const collections = new SqliteCollectionRegistry();
        const stop = await runWorker<OpenSeaReconcileCollectionPayload>(
            queue,
            {
                queue: OPENSEA_QUEUE_NAME.Reconcile,
                consumerName,
                ...policy,
            },
            (envelope) =>
                handleReconcileJob(
                    queue,
                    collections,
                    new SqliteOpenSeaOrderbookRuns(),
                    sync,
                    new OpenSeaReconcilePolicy({
                        reconcileIntervalMs: 15 * 60_000,
                        staleStartThresholdMs: 30 * 60_000,
                    }),
                    { baseDelayMs: 100, maxDelayMs: 1000 },
                    envelope,
                ),
        );
        await queue.publish(
            OPENSEA_QUEUE_NAME.Reconcile,
            job(109, "interrupted"),
        );
        await until(() => started, "interrupted job starts");
        await delay(policy.ackWaitMs * 2);
        assert.equal((await info(broker, prefix)).num_redelivered, 0);
        // Drop the connection before completion: the broker must retain unsatisfied
        // work even though the old handler can no longer ACK or NAK it.
        const stopping = stop();
        await closeQueue(queue);
        release.resolve();
        await stopping;
        assert.equal(
            collections.getCollection(1, 109)?.openseaReconcileCompletedAt,
            null,
        );
        assert.deepEqual(
            db
                .prepare(
                    "SELECT status FROM opensea_orderbook_runs WHERE collection_id=109",
                )
                .all(),
            [{ status: "failed" }],
        );
        return prefix;
    }

    async function recoverWork(broker: Broker, prefix: string) {
        const before = await info(broker, prefix);
        assert.equal(before.num_ack_pending + before.num_pending, 1);
        const queue = await queueFor(broker, prefix);
        let calls = 0;
        const apiCalls: string[] = [];
        const sync = new OpenSeaOrderbookSync(
            {
                async forEachListing() {
                    apiCalls.push("listings");
                },
                async forEachOffer() {
                    apiCalls.push("offers");
                },
            },
            queue,
            new SqliteOrderSourceStateStore({ refreshSeller: () => {} }),
        );
        const collections = new SqliteCollectionRegistry();
        const stop = await runWorker<OpenSeaReconcileCollectionPayload>(
            queue,
            {
                queue: OPENSEA_QUEUE_NAME.Reconcile,
                consumerName,
                ...policy,
            },
            async (envelope) => {
                calls++;
                await handleReconcileJob(
                    queue,
                    collections,
                    new SqliteOpenSeaOrderbookRuns(),
                    sync,
                    new OpenSeaReconcilePolicy({
                        reconcileIntervalMs: 15 * 60_000,
                        staleStartThresholdMs: 30 * 60_000,
                    }),
                    { baseDelayMs: 100, maxDelayMs: 1000 },
                    envelope,
                );
            },
        );
        try {
            await drained(broker, prefix);
            assert.equal(calls, 1);
            assert.deepEqual(apiCalls, ["listings", "offers"]);
            assert(
                collections.getCollection(1, 109)?.openseaReconcileCompletedAt,
            );
            assert.deepEqual(
                db
                    .prepare(
                        "SELECT status FROM opensea_orderbook_runs WHERE collection_id=109 ORDER BY run_id",
                    )
                    .all(),
                [{ status: "failed" }, { status: "completed" }],
            );
            results.restart = {
                recoveredUnsatisfiedJobs: calls,
                completedOrderbookRefreshes: 1,
                ...stateCounts(await info(broker, prefix)),
            };
        } finally {
            await stop();
            await closeQueue(queue);
        }
    }

    class Broker {
        private constructor(
            readonly child: ChildProcess,
            readonly connection: NatsConnection,
            readonly manager: Awaited<
                ReturnType<NatsConnection["jetstreamManager"]>
            >,
            readonly url: string,
        ) {}
        static async start() {
            await mkdir(store, { recursive: true });
            const server = createServer();
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const port = (server.address() as { port: number }).port;
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
            const run = await mkdtemp(path.join(artifacts, "broker-"));
            const config = path.join(run, "server.conf");
            await writeFile(
                config,
                `host: "127.0.0.1"\nport: ${port}\njetstream { store_dir: ${JSON.stringify(store)}, max_file_store: 67108864 }\n`,
            );
            const log = await open(path.join(run, "server.log"), "w");
            const child = spawn(binary, ["-c", config], {
                cwd: root,
                stdio: ["ignore", log.fd, log.fd],
            });
            await log.close();
            const url = `nats://127.0.0.1:${port}`;
            let connection: NatsConnection | undefined;
            try {
                await until(
                    async () => {
                        if (child.exitCode !== null)
                            throw new Error(
                                `NATS exited; inspect ${path.relative(root, run)}`,
                            );
                        try {
                            connection = await connect({
                                servers: url,
                                reconnect: false,
                                timeout: 300,
                            });
                            return true;
                        } catch {
                            return false;
                        }
                    },
                    "fixture broker starts",
                    5000,
                );
                assert(connection);
                return new Broker(
                    child,
                    connection,
                    await connection.jetstreamManager(),
                    url,
                );
            } catch (error) {
                await stopChild(child);
                throw error;
            }
        }
        async stop() {
            await this.connection.close();
            await stopChild(this.child);
        }
    }
    async function stopChild(child: ChildProcess) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
        });
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
        try {
            await exited;
        } finally {
            clearTimeout(timeout);
        }
    }

    let broker: Broker | undefined;
    try {
        broker = await Broker.start();
        await verifyDelivery(broker, false);
        await verifyDelivery(broker, true);
        await verifyBacklog(broker);
        const prefix = await interruptWork(broker);
        await broker.stop();
        broker = await Broker.start(); // Reopen the same persisted synthetic store.
        await recoverWork(broker, prefix);
        await writeFile(
            path.join(artifacts, "results.json"),
            JSON.stringify(results, null, 2) + "\n",
        );
        console.log(JSON.stringify(results, null, 2));
        console.log(`Artifacts: ${path.relative(root, artifacts)}`);
    } finally {
        for (const queue of queues) await queue.close();
        await broker?.stop();
        try {
            db.raw.close();
        } catch {}
    }
}, 60_000);
