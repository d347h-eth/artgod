import { persistCanonicalBlocks } from "../src/infra/storage/sqlite-canonical-headers.js";
import { captureChainSyncCheckpoint } from "../src/infra/storage/sqlite-chain-revisions.js";
import { SYNC_WORK_CLASS as WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { performance } from "node:perf_hooks";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { runWorker } from "../src/application/worker-runner.js";
import { recoverMakerRevalidations } from "../src/application/orders/recover-maker-revalidations.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { QUEUE_OUTBOX_STATUS } from "../src/domain/queue-outbox.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByMakerPayload,
} from "../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { validateSeaportOrder } from "../src/application/offchain/seaport-validate.js";
import {
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MakerRevalidationConflict,
} from "../src/domain/maker-revalidation.js";
import { JobDeferred } from "../src/domain/job-deferred.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import {
    ORDER_VALIDATION_REASON,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
} from "../src/domain/orders.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import type { MakerOrderProjectionPort } from "../src/ports/maker-revalidation.js";
import type {
    QueueMessage,
    QueuePort,
    QueueReplayBoundary,
} from "../src/ports/queue.js";
import {
    HEAVY_MAKER,
    heavyMakerBlock,
    HeavyMakerRpc,
    BatchedHeavyMakerRpc,
    heavyMakerHint,
    heavyMakerOrder,
    seedHeavyMaker,
    warmConduits,
    tokenSaleHint,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { processingTelemetry } from "./helpers/processing-observability.js";
import { ORDER_PROCESSING_OPERATION as OPERATION } from "../src/application/orders/observability.js";
import { QUEUE_OUTBOX_OPERATION } from "../src/application/queue-outbox/drainer.js";
import {
    DOMAIN_PROCESSING_METRIC as METRIC,
    DOMAIN_PROCESSING_METRIC_LABEL as LABEL,
    DOMAIN_PROCESSING_RESULT as RESULT,
    MAKER_RECOVERY_OUTCOME as RECOVERY,
} from "../src/infra/observability/domain-processing-metric-contract.js";

const origin = {
    streamId: "fixture-stream-incarnation",
    consumerName: "fixture-maker-consumer",
    sequence: 10,
};
const request = {
    jobId: "fixture-maker-request",
    payload: heavyMakerHint(),
    origin,
};
const now = HEAVY_MAKER.now * 1_000;

function workflow(
    rpc = new HeavyMakerRpc(),
    wrap?: (orders: SqliteOrdersDomain) => MakerOrderProjectionPort,
    replayBoundary?: (consumerName: string) => Promise<QueueReplayBoundary>,
) {
    // The canonical producer has committed this header; these tests isolate local expansion/replay bookkeeping.
    db.writeTransaction(() =>
        persistCanonicalBlocks(
            captureChainSyncCheckpoint(1),
            [heavyMakerBlock()],
            () => false,
        ),
    )();
    const orders = new SqliteOrdersDomain(HEAVY_MAKER.weth);
    const demand = new SqliteOrderValidationDemand(orders);
    const store = new SqliteMakerRevalidations(
        wrap ? wrap(orders) : orders,
        demand,
        HEAVY_MAKER.weth,
    );
    const processor = new RevalidateMakerOrders({ store, replayBoundary });
    // Checkpoint cases exhaust durable steps locally; broker admission is tested separately.
    const executeAll = async (
        input: Parameters<RevalidateMakerOrders["execute"]>[0],
    ) => {
        await processor.execute(input);
        let run = store.admit({ ...input, now: Date.now() });
        for (let step = 0; run.status !== STATUS.Completed; step++) {
            if (step > 1_000 || run.wakeupOutboxId === null)
                throw new Error("Fixture lost its continuation");
            const row = db
                .prepare("SELECT job_json FROM queue_outbox WHERE outbox_id=?")
                .get(run.wakeupOutboxId) as { job_json: string };
            const job = JSON.parse(row.job_json);
            await processor.execute({
                jobId: job.jobId,
                payload: job.payload,
                origin: input.origin,
            });
            run = store.get(run.runId)!;
        }
    };
    return {
        orders,
        store,
        processor: { execute: executeAll },
        demand,
        stepProcessor: processor,
        rpc,
    };
}

describe("durable maker checkpoints", () => {
    loadTestEnv();
    let dbPath: string;
    beforeAll(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        vi.spyOn(logger, "info").mockImplementation(() => {});
        vi.spyOn(logger, "error").mockImplementation(() => {});
        db.exec(
            "DELETE FROM maker_validation_delivery_origins; DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM order_validation_demand; DELETE FROM chain_sync_revisions; DELETE FROM orders; DELETE FROM blocks; DELETE FROM collections;",
        );
    });
    afterEach(() => vi.restoreAllMocks());

    function continuation(
        work: ReturnType<typeof workflow>,
    ): JobEnvelope<OrderUpdateByMakerPayload> {
        const run = work.store.admit({ ...request, now: Date.now() });
        const row = db
            .prepare("SELECT job_json FROM queue_outbox WHERE outbox_id=?")
            .get(run.wakeupOutboxId) as { job_json: string };
        return JSON.parse(row.job_json);
    }

    it.each(["storage", "broker-boundary"])(
        "retains a maker trigger past the retry ceiling when %s fails before admission",
        async (fault) => {
            vi.spyOn(logger, "warn").mockImplementation(() => {});
            seedHeavyMaker(1);
            let unavailable = true;
            const work = workflow(new HeavyMakerRpc(), undefined, async () => {
                if (fault === "broker-boundary" && unavailable)
                    throw new Error("Replay metadata unavailable");
                return { ...origin, ackFloor: origin.sequence - 1 };
            });
            let deliver!: (
                message: QueueMessage<OrderUpdateByMakerPayload>,
            ) => Promise<void>;
            const publish = vi.fn();
            const queue: QueuePort = {
                publish,
                async subscribe(_queue, handler) {
                    deliver = handler as typeof deliver;
                    return async () => {};
                },
                async close() {},
            };
            await runWorker<OrderUpdateByMakerPayload>(
                queue,
                {
                    queue: QUEUE_NAMES.OrdersUpdateByMaker,
                    consumerName: origin.consumerName,
                    maxAttempts: 1,
                    deadLetterQueue: QUEUE_NAMES.DeadLetter,
                },
                (job, deliveryOrigin) =>
                    work.stepProcessor.execute({
                        jobId: job.jobId,
                        payload: job.payload,

                        origin: deliveryOrigin,
                    }),
            );
            const message: QueueMessage<OrderUpdateByMakerPayload> = {
                data: {
                    ...request,
                    kind: ORDER_JOB_KIND.UpdateByMaker,
                    queue: QUEUE_NAMES.OrdersUpdateByMaker,
                    chainId: HEAVY_MAKER.chainId,
                    scheduledAt: now,
                    attempt: 50,
                },
                origin,
                ack: vi.fn(async () => {}),
                nack: vi.fn(async () => {}),
                touch: vi.fn(async () => {}),
            };
            if (fault === "storage")
                db.exec(
                    "CREATE TEMP TRIGGER reject_maker_admission BEFORE INSERT ON maker_order_revalidation_runs BEGIN SELECT RAISE(ABORT,'fixture admission failure'); END;",
                );
            try {
                await deliver(message);
                expect(message.ack).not.toHaveBeenCalled();
                expect(publish).not.toHaveBeenCalled();
                expect(message.nack).toHaveBeenCalledWith({
                    delayMs: POLICY.admissionRetryMs,
                });
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                        )
                        .get(),
                ).toEqual({ count: 0 });
                expect(work.rpc.reads).toEqual({});
            } finally {
                if (fault === "storage")
                    db.exec("DROP TRIGGER reject_maker_admission");
                unavailable = false;
            }
            await deliver(message);
            expect(message.ack).toHaveBeenCalledOnce();
            expect(publish).not.toHaveBeenCalled();
            expect(work.rpc.reads).toEqual({});
            expect(work.store.admit({ ...request, now })).toMatchObject({
                status: STATUS.Completed,
                deferredOrders: 1,
            });
        },
    );

    it("retains gap continuations, promotes coalesced main demand and resets completed priority", async () => {
        seedHeavyMaker(150);
        const work = workflow();
        const background = {
            ...request,
            payload: { ...request.payload, workClass: WORK_CLASS.GapRepair },
        };
        await work.stepProcessor.execute(background);
        let run = work.store.admit({ ...background, now });
        const before = JSON.parse(
            (
                db
                    .prepare(
                        "SELECT job_json FROM queue_outbox WHERE outbox_id=?",
                    )
                    .get(run.wakeupOutboxId) as { job_json: string }
            ).job_json,
        ) as JobEnvelope<OrderUpdateByMakerPayload>;
        expect(before.workClass).toBe(WORK_CLASS.Main);
        expect(before.payload.workClass).toBe(WORK_CLASS.Main);
        const main = {
            ...background,
            jobId: "main-promotion",
            payload: { ...background.payload, workClass: WORK_CLASS.Main },
        };
        work.store.admit({ ...main, now });
        // Recovery checks the class of the published job, not the now-promoted run.
        const wakeup = work.store.listWakeups(now + 60_000, 16)[0]!;
        expect(wakeup.workClass).toBe(WORK_CLASS.Main);
        await work.processor.execute(background);
        run = work.store.get(run.runId)!;
        expect(run.status).toBe(STATUS.Completed);
        expect(run.payload.workClass).toBe(WORK_CLASS.Main);
        work.store.admit({
            ...background,
            jobId: "later-background",

            now: now + 1,
        });
        expect(work.store.get(run.runId)!.payload.workClass).toBe(
            WORK_CLASS.Main,
        );
    });

    it("coalesces compatible hints across delivery buckets and retains one live-scope proof after ACK", async () => {
        seedHeavyMaker(250);
        const work = workflow();
        const input = { ...request };
        await work.stepProcessor.execute(input);
        for (let i = 0; i < 2_000; i++)
            await work.stepProcessor.execute({
                ...input,
                jobId: `old-hint-${i}`,

                payload: {
                    ...heavyMakerHint(),
                    reason: GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange,
                } as OrderUpdateByMakerPayload,
                origin: { ...origin, sequence: origin.sequence + i + 1 },
            });
        expect(work.rpc.reads).toEqual({});
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 1 });
        await work.processor.execute(input);
        expect(work.rpc.reads).toEqual({});
        expect(work.store.admit({ ...input, now })).toMatchObject({
            generation: 1,
            passGeneration: 1,
            status: STATUS.Completed,
        });
        const boundary = {
            streamId: origin.streamId,
            consumerName: origin.consumerName,
            ackFloor: 10_000,
        };
        expect(work.store.cleanup(boundary, 100)).toBe(0);
        await work.stepProcessor.execute({
            ...input,
            jobId: "old-after-ACK",
            origin: { ...origin, sequence: 3_000 },
        });
        expect(work.rpc.reads).toEqual({});
        db.prepare("DELETE FROM orders WHERE maker=?").run(HEAVY_MAKER.maker);
        expect(work.store.cleanup(boundary, 100)).toBe(1);
    });

    it("reopens a completed scope through one durable continuation and fences prior steps", async () => {
        seedHeavyMaker(50);
        const work = workflow();
        const input = {
            ...request,
            payload: { ...request.payload, blockNumber: null, blockHash: null },
        };
        await work.processor.execute(input);
        const first = work.store.admit({ ...input, now });
        vi.mocked(Date.now).mockReturnValue(now + 1_000);
        await work.stepProcessor.execute({
            ...input,
            jobId: "fresh-hint",
        });
        const next = work.store.get(first.runId)!;
        expect(next).toMatchObject({
            status: STATUS.Pending,
            generation: 2,
            passGeneration: 2,
        });
        expect(next.step).toBeGreaterThan(first.step);
        expect(next.wakeupOutboxId).not.toBeNull();
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 1 });
        await work.processor.execute(input);
        expect(work.rpc.reads).toEqual({});
        expect(work.store.get(first.runId)?.status).toBe(STATUS.Completed);
    });

    it("recovers publication exhaustion including publish-success followed by a failed sent write", async () => {
        const telemetry = await processingTelemetry();
        seedHeavyMaker(150);
        const work = workflow();
        await work.stepProcessor.execute(request);
        const old = continuation(work);
        const outbox = new SqliteQueueOutbox();
        vi.spyOn(outbox, "markSent").mockImplementationOnce(() => {
            throw new Error("lost sent commit");
        });
        const publish = vi.fn(async () => ({
            streamId: origin.streamId,
            sequence: 44,
        }));
        await drainQueueOutbox(outbox, { publish } as never, {
            maxAttempts: 1,
            observability: telemetry.hooks,
        });
        expect(db.prepare("SELECT status FROM queue_outbox").get()).toEqual({
            status: QUEUE_OUTBOX_STATUS.FailedTerminal,
        });
        expect(
            await telemetry.value(METRIC.OutboxPublications, {
                [LABEL.Queue]: QUEUE_NAMES.OrdersUpdateByMaker,
                [LABEL.Status]: QUEUE_OUTBOX_STATUS.FailedTerminal,
            }),
        ).toBe(1);
        expect(
            await telemetry.value(METRIC.Operations, {
                [LABEL.Operation]: QUEUE_OUTBOX_OPERATION.Publish,
                [LABEL.Result]: RESULT.Failure,
            }),
        ).toBe(1);
        const recoveryAt = now + POLICY.recoveryGraceMs + 1;
        vi.mocked(Date.now).mockReturnValue(recoveryAt);
        work.rpc.blockTimestamp = Math.floor(recoveryAt / 1_000);
        expect(
            await recoverMakerRevalidations(
                {
                    store: work.store,
                    isPublicationPending: async () => true,
                    replayBoundaries: async () => [{ ...origin, ackFloor: 0 }],
                    observability: telemetry.hooks,
                },
                recoveryAt,
            ),
        ).toBe(1);
        expect(continuation(work).jobId).not.toBe(old.jobId);
        expect(continuation(work).payload.continuation).toEqual(
            old.payload.continuation,
        );
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 1 });
        await work.stepProcessor.execute({
            jobId: old.jobId,
            payload: old.payload,
            origin,
        });
        await work.processor.execute(request);
        expect(work.rpc.reads).toEqual({});
        await recoverMakerRevalidations(
            {
                store: work.store,
                isPublicationPending: async () => false,
                replayBoundaries: async () => [{ ...origin, ackFloor: 44 }],
                observability: telemetry.hooks,
            },
            recoveryAt,
        );
        expect(
            await telemetry.value(METRIC.Recovery, {
                [LABEL.Outcome]: RECOVERY.Recovered,
            }),
        ).toBe(1);
        expect(await telemetry.value(METRIC.ReceiptsCleaned)).toBe(0);
    });

    it("does not multiply a sent continuation that still exists and repairs an acknowledged lost wakeup", async () => {
        const telemetry = await processingTelemetry();
        vi.spyOn(logger, "warn").mockImplementation(() => {});
        seedHeavyMaker(150);
        const work = workflow();
        await work.stepProcessor.execute(request);
        const outbox = new SqliteQueueOutbox();
        const publication = { streamId: origin.streamId, sequence: 44 };
        await drainQueueOutbox(outbox, {
            publish: async () => publication,
        } as never);
        let pending = true;
        const probe = vi.fn(async (receipt) => {
            expect(receipt).toEqual(publication);
            return pending;
        });
        const deps = {
            store: work.store,
            isPublicationPending: probe,
            replayBoundaries: async () => [{ ...origin, ackFloor: 0 }],
            observability: telemetry.hooks,
        };
        const recoveryAt = now + POLICY.recoveryGraceMs + 1;
        const failure = new Error("broker probe unavailable");
        probe.mockRejectedValueOnce(failure);
        expect(await recoverMakerRevalidations(deps, recoveryAt)).toBe(0);
        expect(
            telemetry.apm.spans.find(
                (span) => span.name === OPERATION.MakerWakeup,
            )?.error,
        ).toBe(failure);
        expect(
            await telemetry.value(METRIC.Recovery, {
                [LABEL.Outcome]: RECOVERY.Failed,
            }),
        ).toBe(1);
        expect(await recoverMakerRevalidations(deps, recoveryAt)).toBe(0);
        pending = false;
        expect(await recoverMakerRevalidations(deps, recoveryAt)).toBe(1);
        expect(probe).toHaveBeenCalledTimes(3);
        expect(work.store.admit({ ...request, now }).wakeupGeneration).toBe(1);
        expect(
            await telemetry.value(METRIC.Recovery, {
                [LABEL.Outcome]: RECOVERY.Checked,
            }),
        ).toBe(3);
        expect(
            await telemetry.value(METRIC.Recovery, {
                [LABEL.Outcome]: RECOVERY.Recovered,
            }),
        ).toBe(1);
    });

    it("cannot replace a wakeup after another executor claims it during the broker probe", async () => {
        seedHeavyMaker(150);
        const work = workflow();
        await work.stepProcessor.execute(request);
        const outbox = new SqliteQueueOutbox();
        await drainQueueOutbox(outbox, {
            publish: async () => ({ streamId: origin.streamId, sequence: 44 }),
        } as never);
        const saved = work.store.admit({ ...request, now });
        const recoveryAt = now + POLICY.recoveryGraceMs + 1;
        expect(
            await recoverMakerRevalidations(
                {
                    store: work.store,
                    isPublicationPending: async () => {
                        expect(
                            work.store.claim(saved.runId, "other", recoveryAt),
                        ).not.toBeNull();
                        return false;
                    },
                    replayBoundaries: async () => [{ ...origin, ackFloor: 0 }],
                },
                recoveryAt,
            ),
        ).toBe(0);
        expect(work.store.get(saved.runId)?.wakeupGeneration).toBe(0);
    });

    it("normalizes request identity and rejects unsupported work before admitting a run", async () => {
        seedHeavyMaker(1);
        const work = workflow();
        const stored = work.store.admit({ ...request, now });
        const equivalent = work.store.admit({
            ...request,
            now,
            payload: {
                ...request.payload,
                maker: request.payload.maker.toUpperCase(),
            },
        });
        expect(equivalent.runId).toBe(stored.runId);
        await expect(
            work.processor.execute({
                ...request,
                jobId: "unknown",
                payload: { ...request.payload, reason: "unsupported" } as never,
            }),
        ).rejects.toThrow("Unsupported maker request");
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 1 });
    });

    it("recognizes completion after a lost ACK and cleans only behind a matching broker boundary", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        vi.mocked(logger.info).mockImplementation((_message, fields) => {
            if (fields?.status === STATUS.Completed)
                throw new Error("crash before ACK");
        });
        await expect(work.processor.execute(request)).rejects.toThrow(
            "before ACK",
        );
        vi.mocked(logger.info).mockImplementation(() => {});
        const calls = { ...work.rpc.reads };
        await work.processor.execute(request);
        expect(work.rpc.reads).toEqual(calls);
        expect(work.store.cleanup({ ...origin, ackFloor: 9 }, 1)).toBe(0);
        expect(
            work.store.cleanup(
                { ...origin, streamId: "replacement-stream", ackFloor: 100 },
                1,
            ),
        ).toBe(0);
        db.prepare("DELETE FROM orders WHERE maker=?").run(HEAVY_MAKER.maker);
        expect(work.store.cleanup({ ...origin, ackFloor: 10 }, 1)).toBe(1);
    });

    it("requires every contributing consumer ACK floor and invalidates proof for a newer delivery", async () => {
        seedHeavyMaker(0);
        const work = workflow();
        const request = {
            jobId: "empty-source-scope",
            payload: {
                ...heavyMakerHint(),
                blockNumber: null,
                blockHash: null,
            },
            origin,
        };
        await work.processor.execute(request);
        const other = {
            ...origin,
            consumerName: "targeted-fixture",
            sequence: 20,
        };
        await work.processor.execute({ ...request, origin: other });
        expect(
            work.store.cleanup(
                {
                    streamId: origin.streamId,
                    consumerName: origin.consumerName,
                    ackFloor: 10,
                },
                100,
            ),
        ).toBe(0);
        expect(
            work.store.cleanup(
                {
                    streamId: other.streamId,
                    consumerName: other.consumerName,
                    ackFloor: 19,
                },
                100,
            ),
        ).toBe(0);
        await work.processor.execute({
            ...request,
            origin: { ...origin, sequence: 11 },
        });
        expect(
            work.store.cleanup(
                {
                    streamId: other.streamId,
                    consumerName: other.consumerName,
                    ackFloor: 20,
                },
                100,
            ),
        ).toBe(0);
        expect(
            work.store.cleanup(
                {
                    streamId: origin.streamId,
                    consumerName: origin.consumerName,
                    ackFloor: 11,
                },
                100,
            ),
        ).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_validation_delivery_origins",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    it("advances independent consumer proofs even when bounded cleanup scans different pages", async () => {
        seedHeavyMaker(0);
        const work = workflow();
        const request = {
            jobId: "empty-source-scope",
            payload: {
                ...heavyMakerHint(),
                blockNumber: null,
                blockHash: null,
            },
            origin,
        };
        const second = {
            ...origin,
            consumerName: "second-consumer",
            sequence: 30,
        };
        for (let i = 0; i < 4; i++) {
            const input = { ...request, jobId: `origins-${i}` };
            await work.processor.execute(input);
            await work.processor.execute({ ...input, origin: second });
        }
        for (let round = 0; round < 8; round++) {
            vi.mocked(Date.now).mockReturnValue(now + round);
            work.store.cleanup(
                {
                    streamId: origin.streamId,
                    consumerName: origin.consumerName,
                    ackFloor: 100,
                },
                1,
            );
            work.store.cleanup(
                {
                    streamId: second.streamId,
                    consumerName: second.consumerName,
                    ackFloor: 100,
                },
                1,
            );
        }
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    it("inspects distinct pending scopes in bounded rotating recovery pages", () => {
        seedHeavyMaker(0);
        const work = workflow();
        for (let i = 0; i < POLICY.recoveryRows + 2; i++)
            work.store.admit({
                ...request,
                jobId: `recover-${i}`,
                now,
                payload: {
                    ...request.payload,
                    maker: `0x${(i + 1).toString(16).padStart(40, "0")}`,
                    blockNumber: null,
                    blockHash: null,
                },
            });
        const at = now + POLICY.recoveryGraceMs + 1;
        const first = work.store.listWakeups(at, POLICY.recoveryRows);
        const second = work.store.listWakeups(at + 1, POLICY.recoveryRows);
        expect(first).toHaveLength(POLICY.recoveryRows);
        expect(
            new Set([...first, ...second].map((wakeup) => wakeup.run.runId))
                .size,
        ).toBe(POLICY.recoveryRows + 2);
    });

    it("reopens SQLite after a durable page and resumes without duplicating handed-off demand", async () => {
        seedHeavyMaker(205);
        const work = workflow();
        await work.stepProcessor.execute(request);
        const before = work.store.admit({ ...request, now })!;
        expect(before).toMatchObject({
            deferredOrders: 100,
            status: STATUS.Pending,
        });
        db.raw.close();
        setDbPath(dbPath);
        const restarted = workflow();
        await restarted.processor.execute(request);
        expect(restarted.store.get(before.runId)).toMatchObject({
            deferredOrders: 205,
            status: STATUS.Completed,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count,MAX(generation) AS generation FROM order_validation_demand",
                )
                .get(),
        ).toEqual({ count: 205, generation: 1 });
    });

    it("retains an obligation during an abandoned lease and recovers it after expiry", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        const run = work.store.admit({ ...request, now })!;
        work.store.claim(run.runId, "dead-process", now);
        db.raw.close();
        setDbPath(dbPath);
        const restarted = workflow();
        await restarted.stepProcessor.execute(request);
        expect(restarted.store.get(run.runId)).toMatchObject({
            deferredOrders: 0,
            status: STATUS.Pending,
        });
        vi.mocked(Date.now).mockReturnValue(now + POLICY.leaseMs + 1);
        await restarted.processor.execute(request);
        expect(restarted.store.get(run.runId)).toMatchObject({
            deferredOrders: 3,
            status: STATUS.Completed,
        });
    });
});
