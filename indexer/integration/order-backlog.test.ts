import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    resolveNatsJobStreamName,
    resolveNatsJobSubject,
} from "@artgod/shared/queue/nats-job-stream";
import { buildOrderQueueTestWorker } from "../../scripts/build/build-order-queue-test-worker.mjs";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
} from "../src/domain/order-jobs.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import { LEGACY_ORDER_ADMISSION_POLICY } from "../src/infra/orders/legacy-order-admission.js";
import {
    HEAVY_MAKER,
    seedHeavyMaker,
    heavyMakerOrder,
} from "../tests/fixtures/heavy-maker.js";
import {
    QUEUE_FIXTURE_COMMAND as COMMAND,
    QUEUE_FIXTURE_PHASE as PHASE,
    type QueueFixtureProgress,
} from "../tests/fixtures/order-queue-protocol.js";
import { loadOrderQueueTestConfig } from "../tests/helpers/order-queue-test-config.js";
import {
    IsolatedNats,
    stopFixtureChild,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";

it("converges a legacy mixed backlog with sustained arrivals, bounded metadata and pause/resume, preserving unsupported bytes", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const base = path.join(root, "tmp/order-backlog-nats");
    await mkdir(base, { recursive: true });
    const artifacts = await mkdtemp(path.join(base, "run-"));
    const dbPath = path.join(artifacts, "orders.sqlite");
    const workerPath = path.join(artifacts, "worker.mjs");
    await buildOrderQueueTestWorker(workerPath);
    const prefix = "legacy-backlog";
    const stream = resolveNatsJobStreamName(prefix);
    const consumerName = `id-${QUEUE_NAMES.OrdersUpdateById}-fixture`;
    const clockStart = HEAVY_MAKER.now * 1000;
    const monotonicStart = performance.now();
    const clock = () =>
        clockStart + Math.floor(performance.now() - monotonicStart);
    const children = new Set<ChildProcess>();
    let broker: IsolatedNats | undefined;
    let publisher: NatsJetStreamQueue | undefined;
    let stopArrivals = false;
    let arrivals: Promise<void> | undefined;
    let arrivalCount = 0;
    let arrivalElapsedMs = 0;
    const snapshots: QueueFixtureProgress[] = [];
    const summaries: QueueFixtureProgress[] = [];
    const { natsBinary } = loadOrderQueueTestConfig();

    async function startWorker(index: number) {
        const config = path.join(artifacts, `worker-${index}.json`);
        await writeFile(
            config,
            JSON.stringify({
                dbPath,
                natsUrl: broker!.url,
                prefix,
                clockMs: clock(),
                holdAtRead: null,
                advanceClock: true,
                rpcDelayMs: 2,
                reportEvery: 100,
            }),
        );
        const child = spawn(process.execPath, [workerPath, config], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            env: { ...process.env, ARTGOD_WORKSPACE_ROOT: root },
        });
        children.add(child);
        let output = "",
            ready = false;
        let latest: QueueFixtureProgress | undefined;
        const capture = (chunk: Buffer) => {
            output = (output + String(chunk)).slice(-6000);
        };
        child.stdout!.on("data", capture);
        child.stderr!.on("data", capture);
        child.on("message", (message) => {
            const value = message as QueueFixtureProgress;
            if (value.phase === PHASE.Ready) ready = true;
            if (
                value.phase === PHASE.Progress ||
                value.phase === PHASE.Summary
            ) {
                latest = value;
                snapshots.push(value);
                if (value.phase === PHASE.Summary) summaries.push(value);
            }
        });
        const wait = (
            check: () => boolean | Promise<boolean>,
            label: string,
            timeout = 20_000,
        ) =>
            waitForFixture(
                () => {
                    if (child.exitCode !== null || child.signalCode !== null)
                        throw new Error(
                            `Worker exited during ${label}: ${output}`,
                        );
                    return check();
                },
                label,
                timeout,
            );
        await wait(() => ready, "legacy worker ready");
        return {
            child,
            wait,
            latest: () => latest,
            async stop() {
                child.send(COMMAND.Stop);
                await waitForFixture(
                    () => child.exitCode !== null || child.signalCode !== null,
                    "legacy worker pause",
                );
                expect(child.exitCode, output).toBe(0);
                children.delete(child);
            },
        };
    }

    async function publish(
        id: string,
        payload: OrderUpdateByIdPayload,
        scheduledAt: number,
        queue: QueueName = QUEUE_NAMES.OrdersUpdateById,
        kind: string = ORDER_JOB_KIND.UpdateById,
    ) {
        return publisher!.publish(queue, {
            jobId: id,
            kind,
            queue,
            chainId: 1,
            scheduledAt,
            attempt: 0,
            payload,
        });
    }
    try {
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
        const { sale } = seedHeavyMaker();
        const initialBytes =
            Number(db.raw.pragma("page_count", { simple: true })) *
            Number(db.raw.pragma("page_size", { simple: true }));
        db.raw.close();
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "nats"),
        );
        publisher = await NatsJetStreamQueue.connect({
            natsUrl: broker.url,
            streamPrefix: prefix,
        });
        const oldTime = clockStart - 18 * 3600 * 1000;
        // The 10,000-envelope ratio mirrors the observed oldest sample, not all live traffic.
        for (let i = 0; i < 10_000; i++) {
            const validation = i < 7719;
            const order = heavyMakerOrder(
                validation ? i % 200 : (i - 7719) % 1000,
            );
            await publish(
                `old-${i}`,
                {
                    chainId: 1,
                    collectionId: order.collectionId,
                    orderId: order.id,
                    reason: validation
                        ? ORDER_UPDATE_REASON.Validation
                        : ORDER_UPDATE_REASON.Cancel,
                    ...(validation
                        ? {}
                        : {
                              sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                              observedAt: HEAVY_MAKER.now,
                              validUntil: order.validUntil,
                          }),
                },
                oldTime,
            );
        }
        await publish(
            "buried-source-fill",
            {
                chainId: 1,
                collectionId: sale.collectionId,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Fill,
                sourceStatus: ORDER_SOURCE_STATUS.Filled,
                observedAt: HEAVY_MAKER.now,
            },
            oldTime,
        );
        await publish(
            "buried-chain-fill",
            {
                chainId: 1,
                collectionId: sale.collectionId,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Fill,
                blockNumber: HEAVY_MAKER.blockNumber,
            },
            oldTime,
        );
        const initialStream = (
            await broker.connection.jetstreamManager()
        ).streams.info(stream);
        const started = performance.now();
        const first = await startWorker(1);
        arrivals = (async () => {
            const began = performance.now();
            for (let i = 0; i < 1000 && !stopArrivals; i++) {
                const order = heavyMakerOrder(1000 + (i % 50));
                await publish(
                    `incoming-${i}`,
                    {
                        chainId: 1,
                        orderId: order.id,
                        reason: ORDER_UPDATE_REASON.Validation,
                    },
                    clock() - 1000,
                );
                arrivalCount++;
                await delay(20);
            }
            arrivalElapsedMs = performance.now() - began;
        })();
        await first.wait(
            () => (first.latest()?.handled ?? 0) >= 2000,
            "partial legacy progress",
            25_000,
        );
        await first.stop();
        const manager = await broker.connection.jetstreamManager();
        const paused = await manager.consumers.info(stream, consumerName);
        await delay(250);
        const stillPaused = await manager.consumers.info(stream, consumerName);
        expect(stillPaused.ack_floor).toEqual(paused.ack_floor);
        expect(stillPaused.delivered).toEqual(paused.delivered);
        const second = await startWorker(2);
        await arrivals;
        await second.wait(
            async () =>
                (await manager.streams.info(stream)).state.messages === 0,
            "mixed legacy backlog drains",
            75_000,
        );
        let requestedAt = 0;
        await second.wait(() => {
            if (performance.now() - requestedAt > 100) {
                second.child.send(COMMAND.Report);
                requestedAt = performance.now();
            }
            return (
                second.latest()?.handled ===
                    10002 + arrivalCount - summaries[0]!.handled &&
                second.latest()?.pending === 0
            );
        }, "admitted validation settles");
        const completionMs = performance.now() - started;
        expect(arrivalCount).toBe(1000);
        const final = second.latest()!;
        expect(summaries[0]!.handled + final.handled).toBe(11002);
        expect(summaries[0]!.terminalFacts + final.terminalFacts).toBe(2283);
        expect(final.demandRows).toBeLessThanOrEqual(250);
        expect(final.oldestDemandAgeMs).toBe(0);
        expect(snapshots.every((sample) => sample.outboxRows === 0)).toBe(true);
        expect(
            Math.max(...snapshots.map((s) => s.demandRows)),
        ).toBeLessThanOrEqual(250);
        expect(completionMs).toBeGreaterThan(
            11000 * LEGACY_ORDER_ADMISSION_POLICY.intervalMs - 1000,
        );

        // Unsupported envelopes cannot disappear through the log-only dead-letter worker.
        const unsupported = await publish(
            "future-order",
            { chainId: 1, orderId: sale.id, reason: "future-lifecycle" },
            clock() - 1000,
        );
        const raw = Buffer.from("{unfinished-json");
        const rawReceipt = await broker.connection
            .jetstream()
            .publish(
                resolveNatsJobSubject(prefix, QUEUE_NAMES.OrderLifecycle),
                raw,
            );
        await second.wait(async () => {
            const legacy = await manager.consumers.info(stream, consumerName);
            const lifecycle = await manager.consumers.info(
                stream,
                `id-${QUEUE_NAMES.OrderLifecycle}-fixture`,
            );
            return (
                legacy.delivered.stream_seq >= unsupported!.sequence &&
                lifecycle.delivered.stream_seq >= rawReceipt.seq
            );
        }, "unsupported envelopes observed");
        expect(
            (
                await manager.streams.getMessage(stream, {
                    seq: unsupported!.sequence,
                })
            ).json(),
        ).toMatchObject({ jobId: "future-order" });
        expect(
            Buffer.from(
                (
                    await manager.streams.getMessage(stream, {
                        seq: rawReceipt.seq,
                    })
                ).data,
            ).equals(raw),
        ).toBe(true);
        expect((await manager.streams.info(stream)).state.messages).toBe(2);
        await second.stop();
        await publisher.close();
        publisher = undefined;
        await broker.stop();
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "nats"),
        );
        expect(
            (
                await (
                    await broker.connection.jetstreamManager()
                ).streams.info(stream)
            ).state.messages,
        ).toBe(2);

        setDbPath(dbPath);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE source_status=?",
                )
                .get(ORDER_SOURCE_STATUS.Cancelled),
        ).toEqual({ count: 1000 });
        expect(
            db
                .prepare(
                    "SELECT source_status,fillability_status FROM orders WHERE id=?",
                )
                .get(sale.id),
        ).toEqual({
            source_status: ORDER_SOURCE_STATUS.Filled,
            fillability_status: ORDER_STATUS.Filled,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1",
                )
                .get(),
        ).toEqual({ count: 0 });
        const result = {
            workload: {
                initialEnvelopes: 10002,
                legacyValidationHints: 7719,
                legacyCancellations: 2281,
                fillFacts: 2,
                liveOrders: HEAVY_MAKER.count + 2,
                arrivingEnvelopes: arrivalCount,
                arrivingDistinctOrders: 50,
            },
            arrivalEnvelopesPerSecond: (arrivalCount * 1000) / arrivalElapsedMs,
            completedEnvelopesPerSecond: (11002 * 1000) / completionMs,
            completionMs,
            usefulOrderValidations: summaries.reduce(
                (n, s) => n + (s.reads.getOrderStatus ?? 0),
                0,
            ),
            contractReads: summaries.reduce(
                (n, s) => n + Object.values(s.reads).reduce((a, b) => a + b, 0),
                0,
            ),
            cpuMs: summaries.reduce((n, s) => n + s.cpuMs, 0),
            sqliteAdmissionMs: summaries.reduce(
                (n, s) => n + s.sqliteAdmissionMs,
                0,
            ),
            maximumDemandRows: Math.max(...snapshots.map((s) => s.demandRows)),
            oldestUsefulDemandAgeAtEndMs: final.oldestDemandAgeMs,
            maximumTerminalAgeMs: final.maximumTerminalAgeMs,
            databaseAllocatedGrowthBytes: final.allocatedBytes - initialBytes,
            initialBrokerBytes: (await initialStream).state.bytes,
            maximumRssKiB: Math.max(...summaries.map((s) => s.maximumRssKiB)),
            unsupportedEnvelopesRetained: 2,
            pauseAckFloor: paused.ack_floor.stream_seq,
            maximumActiveValidations: Math.max(
                ...snapshots.map((s) => s.maximumValidations),
            ),
            samples: snapshots,
        };
        await writeFile(
            path.join(artifacts, "results.json"),
            JSON.stringify(result, null, 2) + "\n",
        );
    } finally {
        stopArrivals = true;
        await arrivals?.catch(() => {});
        for (const child of children) await stopFixtureChild(child, "SIGKILL");
        await publisher?.close();
        await broker?.stop();
        try {
            db.raw.close();
        } catch {}
    }
}, 150_000);
