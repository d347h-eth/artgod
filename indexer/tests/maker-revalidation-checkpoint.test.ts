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
    const validateOrder = (order: Parameters<typeof validateSeaportOrder>[3]) =>
        validateSeaportOrder(
            rpc,
            warmConduits,
            { conduitController: HEAVY_MAKER.controller },
            order,
        );
    const orders = new SqliteOrdersDomain(HEAVY_MAKER.weth, validateOrder);
    const demand = new SqliteOrderValidationDemand(orders);
    const store = new SqliteMakerRevalidations(
        wrap ? wrap(orders) : orders,
        demand,
    );
    const processor = new RevalidateMakerOrders({
        admission: new FairOrderValidationAdmission(2),
        store,
        replayBoundary,
        createSnapshot: createSeaportOrderValidationFactory({
            chainId: HEAVY_MAKER.chainId,
            rpc,
            conduits: warmConduits,
            conduitController: HEAVY_MAKER.controller,
        }),
    });
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
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
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
                        requiredAt: job.scheduledAt,
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
            expect(work.rpc.reads.getOrderStatus).toBe(1);
            expect(
                work.store.admit({ ...request, requiredAt: now, now }),
            ).toMatchObject({
                status: STATUS.Completed,
                resolvedOrders: 1,
            });
        },
    );

    it("validates all 9,339 bids through durable steps with bounded status aggregates", async () => {
        seedHeavyMaker();
        const rpc = new BatchedHeavyMakerRpc();
        const work = workflow(rpc);
        const started = performance.now();
        await work.processor.execute(request);
        const contexts = Math.ceil(HEAVY_MAKER.count / POLICY.batchOrders);
        expect(work.store.admit({ ...request, now }).resolvedOrders).toBe(
            HEAVY_MAKER.count,
        );
        expect(rpc.reads).toEqual({
            getOrderStatus: HEAVY_MAKER.count,
            getCounter: contexts,
            allowance: contexts,
            balanceOf: contexts,
        });
        expect(rpc.batches).toHaveLength(467);
        expect(rpc.virtualMs).toBe(7_490);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0 AND fillability_status=?",
                )
                .get(ORDER_STATUS.Fillable),
        ).toEqual({ count: HEAVY_MAKER.count });
        process.stdout.write(
            JSON.stringify({
                scenario: "heavy-maker-status-batched-durable-fake-rpc",
                orders: HEAVY_MAKER.count,
                contexts,
                logicalContractReads: Object.values(rpc.reads).reduce(
                    (a, b) => a + b,
                    0,
                ),
                statusBatches: rpc.batches.length,
                contractRpcCalls: rpc.virtualMs / 10,
                syntheticRpcMs: rpc.virtualMs,
                localMs: Math.round(performance.now() - started),
            }) + "\n",
        );
    }, 60_000);

    it.each(["fallback", "reorg"])(
        "keeps the prior checkpoint when a status aggregate has a %s failure",
        async (failure) => {
            seedHeavyMaker(3);
            const rpc = new BatchedHeavyMakerRpc();
            if (failure === "fallback") {
                vi.spyOn(rpc, "readContracts").mockRejectedValue(
                    new Error("aggregate unavailable"),
                );
                rpc.onRead = () => {
                    throw new Error("individual read unavailable");
                };
            } else
                rpc.onRead = () => {
                    rpc.blockHash = `0x${"cd".repeat(32)}`;
                };
            const work = workflow(rpc);
            await expect(work.stepProcessor.execute(request)).rejects.toThrow();
            expect(work.store.admit({ ...request, now }).resolvedOrders).toBe(
                0,
            );
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0 OR fillability_status<>?",
                    )
                    .get(ORDER_STATUS.Fillable),
            ).toEqual({ count: 0 });
        },
    );

    it("yields after 100 orders and services a small maker and token before the heavy pass finishes", async () => {
        const { small, sale } = seedHeavyMaker(250);
        const work = workflow();
        await work.stepProcessor.execute(request);
        expect(work.store.admit({ ...request, now })).toMatchObject({
            status: STATUS.Pending,
            resolvedOrders: 100,
            step: 1,
        });
        const firstContinuation = continuation(work);
        await work.stepProcessor.execute({
            jobId: "small",
            payload: heavyMakerHint(small.maker),
            origin,
        });
        await work.stepProcessor.execute({
            jobId: "token",
            payload: tokenSaleHint(sale),
            origin,
        });
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(sale.id),
        ).toEqual({ fillability_status: ORDER_STATUS.NoBalance });
        expect(work.store.admit({ ...request, now }).resolvedOrders).toBe(100);
        await work.stepProcessor.execute({
            jobId: firstContinuation.jobId,
            payload: firstContinuation.payload,
            origin,
        });
        const reads = work.rpc.reads.getOrderStatus;
        await work.stepProcessor.execute({
            jobId: firstContinuation.jobId,
            payload: firstContinuation.payload,
            origin,
        });
        await work.stepProcessor.execute(request); // Lost original ACK cannot start another step.
        expect(work.rpc.reads.getOrderStatus).toBe(reads);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 1 });
        await work.processor.execute(request);
        expect(work.store.admit({ ...request, now }).resolvedOrders).toBe(250);
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get(),
        ).toEqual({ count: 0 });
    });

    it("stops admitting work after the elapsed step budget", async () => {
        seedHeavyMaker(50);
        const work = workflow();
        work.rpc.onRead = () => {
            vi.mocked(Date.now).mockReturnValue(now + POLICY.stepBudgetMs);
        };
        await work.stepProcessor.execute(request);
        expect(work.store.admit({ ...request, now }).resolvedOrders).toBe(1);
        expect(continuation(work).attempt).toBe(0);
    });

    it("coalesces compatible hints across delivery buckets and retains one live-scope proof after ACK", async () => {
        seedHeavyMaker(250);
        const work = workflow();
        const input = { ...request, requiredAt: now - 1_000 };
        await work.stepProcessor.execute(input);
        for (let i = 0; i < 2_000; i++)
            await work.stepProcessor.execute({
                ...input,
                jobId: `old-hint-${i}`,
                requiredAt: now - 500,
                payload: {
                    ...heavyMakerHint(),
                    reason: GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange,
                } as OrderUpdateByMakerPayload,
                origin: { ...origin, sequence: origin.sequence + i + 1 },
            });
        expect(work.rpc.reads.getOrderStatus).toBe(100);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 1 });
        await work.processor.execute(input);
        expect(work.rpc.reads.getOrderStatus).toBe(250);
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
        expect(work.rpc.reads.getOrderStatus).toBe(250);
        db.prepare("DELETE FROM orders WHERE maker=?").run(HEAVY_MAKER.maker);
        expect(work.store.cleanup(boundary, 100)).toBe(1);
    });

    it("persists one complete follow-up for newer hints behind the cursor, including restart at the pass boundary", async () => {
        seedHeavyMaker(205);
        let work = workflow();
        const input = { ...request, requiredAt: now - 1_000 };
        await work.stepProcessor.execute(input);
        const staleContinuation = continuation(work);
        vi.mocked(Date.now).mockReturnValue(now + 1_000);
        work.rpc.balance = 0n;
        work.rpc.blockNumber = HEAVY_MAKER.blockNumber + 1;
        const newer = {
            ...input,
            jobId: "newer-hint",
            requiredAt: now + 1_000,
            payload: {
                ...heavyMakerHint(),
                blockNumber: HEAVY_MAKER.blockNumber + 1,
            },
        };
        for (let i = 0; i < 100; i++)
            await work.stepProcessor.execute({
                ...newer,
                jobId: `newer-hint-${i}`,
            });
        expect(work.store.admit({ ...input, now: Date.now() })).toMatchObject({
            generation: 2,
            passGeneration: 1,
            resolvedOrders: 100,
        });
        for (let step = 0; step < 2; step++) {
            const job = continuation(work);
            await work.stepProcessor.execute({
                jobId: job.jobId,
                payload: job.payload,
                origin,
            });
        }
        const boundary = work.store.admit({ ...input, now: Date.now() });
        expect(boundary).toMatchObject({
            status: STATUS.Pending,
            passGeneration: 2,
            afterId: "",
            resolvedOrders: 205,
        });
        db.raw.close();
        setDbPath(dbPath);
        work = workflow();
        work.rpc.balance = 0n;
        work.rpc.blockNumber = HEAVY_MAKER.blockNumber + 1;
        await work.stepProcessor.execute({
            jobId: staleContinuation.jobId,
            payload: staleContinuation.payload,
            origin,
        });
        expect(work.rpc.reads.getOrderStatus).toBeUndefined();
        await work.processor.execute(input);
        expect(work.rpc.reads.getOrderStatus).toBe(205);
        expect(work.store.admit({ ...input, now: Date.now() })).toMatchObject({
            status: STATUS.Completed,
            generation: 2,
            passGeneration: 2,
            resolvedOrders: 410,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE maker=? AND fillability_status=?",
                )
                .get(HEAVY_MAKER.maker, ORDER_STATUS.NoBalance),
        ).toEqual({ count: 205 });
    });

    it("reopens a completed scope through one durable continuation and fences prior steps", async () => {
        seedHeavyMaker(50);
        const work = workflow();
        const input = { ...request, requiredAt: now - 1_000 };
        await work.processor.execute(input);
        const first = work.store.admit({ ...input, now });
        vi.mocked(Date.now).mockReturnValue(now + 1_000);
        await work.stepProcessor.execute({
            ...input,
            jobId: "fresh-hint",
            requiredAt: now + 1_000,
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
        expect(work.rpc.reads.getOrderStatus).toBe(100);
        expect(work.store.get(first.runId)?.status).toBe(STATUS.Completed);
    });

    it("keeps chain, maker, selector and bootstrap-gating modes separate, with conservative legacy runs", () => {
        seedHeavyMaker(1);
        const work = workflow();
        const admit = (
            jobId: string,
            payload: OrderUpdateByMakerPayload,
            requiredAt: number | undefined = now,
        ) => work.store.admit({ jobId, payload, requiredAt, now });
        const base = admit("base", heavyMakerHint());
        expect(
            admit("allowance", {
                ...heavyMakerHint(),
                reason: GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange,
            } as OrderUpdateByMakerPayload).runId,
        ).toBe(base.runId);
        const separate = [
            admit("counter", {
                ...heavyMakerHint(),
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            } as OrderUpdateByMakerPayload),
            admit("other-chain", { ...heavyMakerHint(), chainId: 2 }),
            admit("other-maker", heavyMakerHint(HEAVY_MAKER.smallMaker)),
            admit("unanchored", { ...heavyMakerHint(), blockNumber: null }),
            work.store.admit({
                jobId: "legacy-without-time",
                payload: heavyMakerHint(),
                now,
            }),
        ];
        expect(
            new Set([base.runId, ...separate.map((run) => run.runId)]).size,
        ).toBe(6);
    });

    it("records newer demand while the first step is still in flight before an outbox exists", async () => {
        seedHeavyMaker(50);
        const work = workflow();
        const input = { ...request, requiredAt: now - 1_000 };
        work.rpc.onRead = async () => {
            work.rpc.onRead = undefined;
            vi.mocked(Date.now).mockReturnValue(now + 1);
            await work.stepProcessor.execute({
                ...input,
                jobId: "during-first-step",
                requiredAt: now + 1,
            });
        };
        await work.stepProcessor.execute(input);
        expect(work.store.admit({ ...input, now })).toMatchObject({
            status: STATUS.Pending,
            generation: 2,
            passGeneration: 2,
        });
        vi.mocked(Date.now).mockReturnValue(now + 1);
        await work.processor.execute(input);
        expect(work.rpc.reads.getOrderStatus).toBe(100);
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
        expect(work.rpc.reads.getOrderStatus).toBe(150);
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
        expect(await telemetry.value(METRIC.ReceiptsCleaned)).toBe(1);
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

    it("inspects all pending runs in bounded rotating recovery pages", () => {
        seedHeavyMaker(1);
        const work = workflow();
        for (let i = 0; i < POLICY.recoveryRows + 2; i++)
            work.store.admit({ ...request, jobId: `recover-${i}`, now });
        const at = now + POLICY.recoveryGraceMs + 1;
        const first = work.store.listWakeups(at, POLICY.recoveryRows);
        const second = work.store.listWakeups(at + 1, POLICY.recoveryRows);
        expect(first).toHaveLength(POLICY.recoveryRows);
        expect(
            new Set([...first, ...second].map((wakeup) => wakeup.run.runId))
                .size,
        ).toBe(POLICY.recoveryRows + 2);
    });

    it("recovers a persisted executor that died without releasing its lease", async () => {
        seedHeavyMaker(110);
        const dead = workflow();
        const admitted = dead.store.admit({ ...request, now });
        const claimed = dead.store.claim(admitted.runId, "dead-process", now)!;
        const checkpoint = dead.store.checkpoint(
            claimed,
            dead.store.next(claimed, 100).map((candidate) => ({
                candidate,
                validation: {
                    status: ORDER_STATUS.Fillable,
                    reason: "fixture committed before death",
                },
            })),
            false,
            now,
        );
        setDbPath(dbPath); // No release: simulate losing every in-memory executor object.
        const restarted = workflow();
        await expect(restarted.processor.execute(request)).rejects.toThrow(
            JobDeferred,
        );
        const recoveredAt = now + POLICY.leaseMs + 1;
        vi.mocked(Date.now).mockReturnValue(recoveredAt);
        restarted.rpc.blockTimestamp = Math.floor(recoveredAt / 1_000);
        await restarted.processor.execute(request);
        expect(restarted.rpc.reads.getOrderStatus).toBe(10);
        expect(restarted.store.get(checkpoint.runId)).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 110,
            leaseOwner: null,
        });
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

    it("reopens SQLite and resumes after the last committed context with fresh RPC state", async () => {
        seedHeavyMaker(510);
        const first = workflow();
        first.rpc.onRead = ({ functionName }) => {
            expect(db.raw.inTransaction).toBe(false);
            if (
                functionName === "getOrderStatus" &&
                first.rpc.reads.getOrderStatus === 101
            )
                throw new Error("crash before result");
        };
        await expect(first.processor.execute(request)).rejects.toThrow();
        const before = first.store.admit({ ...request, now });
        expect(before).toMatchObject({
            resolvedOrders: 100,
            status: STATUS.Pending,
            failures: 1,
            leaseOwner: null,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0",
                )
                .get(),
        ).toEqual({ count: 100 });
        setDbPath(dbPath);
        const restarted = workflow();
        restarted.rpc.balance = 0n;
        await restarted.processor.execute(request);
        expect(restarted.rpc.reads.getOrderStatus).toBe(410);
        expect(restarted.store.get(before.runId)).toMatchObject({
            resolvedOrders: 510,
            status: STATUS.Completed,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE maker=? AND fillability_status=?",
                )
                .get(HEAVY_MAKER.maker, ORDER_STATUS.NoBalance),
        ).toEqual({ count: 410 });
    });

    it.each(["failure", "busy"])(
        "rolls back effects and progress together after a write %s",
        async (fault) => {
            seedHeavyMaker(3);
            let injected = false;
            const work = workflow(new HeavyMakerRpc(), (orders) => ({
                captureMakerPass: () => orders.captureMakerPass(),
                selectMakerCandidates: (...args) =>
                    orders.selectMakerCandidates(...args),
                applyMakerResolution: (...args) => {
                    orders.applyMakerResolution(...args);
                    if (!injected) {
                        injected = true;
                        if (fault === "busy")
                            throw Object.assign(new Error("busy"), {
                                code: "SQLITE_BUSY",
                            });
                        throw new Error("crash between effect and checkpoint");
                    }
                },
            }));
            if (fault === "failure") {
                await expect(work.processor.execute(request)).rejects.toThrow(
                    "between effect and checkpoint",
                );
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0",
                        )
                        .get(),
                ).toEqual({ count: 0 });
                expect(work.store.admit({ ...request, now })).toMatchObject({
                    afterId: "",
                    resolvedOrders: 0,
                });
                await work.processor.execute(request);
            } else {
                await work.processor.execute(request);
                expect(work.rpc.reads.getOrderStatus).toBe(3);
            }
            expect(work.store.admit({ ...request, now })).toMatchObject({
                status: STATUS.Completed,
                resolvedOrders: 3,
            });
        },
    );

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
        expect(work.store.cleanup({ ...origin, ackFloor: 10 }, 1)).toBe(1);
    });

    it("requires every contributing consumer ACK floor and invalidates proof for a newer delivery", async () => {
        seedHeavyMaker(0);
        const work = workflow();
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

    it("fences an expired executor and defers duplicate delivery without advancing progress", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        const admitted = work.store.admit({ ...request, now });
        const old = work.store.claim(admitted.runId, "old-executor", now)!;
        await expect(work.processor.execute(request)).rejects.toThrow(
            JobDeferred,
        );
        const newer = work.store.claim(
            admitted.runId,
            "new-executor",
            now + POLICY.leaseMs + 1,
        )!;
        expect(newer.leaseVersion).toBe(old.leaseVersion + 1);
        const resolutions = work.store.next(old, 100).map((candidate) => ({
            candidate,
            validation: {
                status: ORDER_STATUS.NoBalance,
                reason: "fixture",
            },
        }));
        expect(() =>
            work.store.checkpoint(
                old,
                resolutions,
                true,
                now + POLICY.leaseMs + 2,
            ),
        ).toThrow(MakerRevalidationConflict);
        expect(work.store.renew(old, now + POLICY.leaseMs + 2)).toBe(false);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    it("retries a changed active revision instead of checkpointing past unvalidated state", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        let changed = false;
        work.rpc.onRead = ({ functionName, args }) => {
            if (!changed && functionName === "getOrderStatus") {
                changed = true;
                db.prepare(
                    "UPDATE orders SET state_revision=state_revision+1,validated_at=0 WHERE id=?",
                ).run(args![0]);
            }
        };
        await expect(work.processor.execute(request)).rejects.toThrow(
            MakerRevalidationConflict,
        );
        expect(work.store.admit({ ...request, now })).toMatchObject({
            afterId: "",
            resolvedOrders: 0,
        });
        await work.processor.execute(request);
        expect(work.store.admit({ ...request, now })).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 3,
        });
    });

    it("resolves deleted and source-terminal candidates without reviving them", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        const ids = db
            .prepare("SELECT id FROM orders WHERE maker=? ORDER BY id")
            .all(HEAVY_MAKER.maker) as { id: string }[];
        let changed = false;
        work.rpc.onRead = async () => {
            if (changed) return;
            changed = true;
            db.prepare("DELETE FROM orders WHERE id=?").run(ids[0]!.id);
            await work.orders.handleOrderUpdateById({
                chainId: 1,
                orderId: ids[1]!.id,
                reason: "cancel",
                sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                observedAt: HEAVY_MAKER.now,
            });
        };
        await work.processor.execute(request);
        expect(work.store.admit({ ...request, now })).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 3,
        });
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(ids[1]!.id),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Cancelled });
    });

    it("keeps a finite admission boundary and leaves new orders behind the cursor for follow-up", async () => {
        seedHeavyMaker(110);
        const work = workflow();
        let newId: string | undefined;
        work.rpc.onRead = async ({ functionName }) => {
            if (
                functionName !== "getOrderStatus" ||
                work.rpc.reads.getOrderStatus !== 101
            )
                return;
            const saved = work.store.admit({ ...request, now });
            let index = 10_000;
            let order = heavyMakerOrder(index);
            while (order.id >= saved.afterId) order = heavyMakerOrder(++index);
            newId = order.id;
            const outcome = await work.orders.handleOrderUpsert({
                ...order,
                side: "buy",
                source: "opensea",
                orderId: order.id,
                sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
                rawSourceKind: "rest",
                observedAt: HEAVY_MAKER.now,
                validateAfterUpsert: true,
            });
            expect(outcome.validationNeeded).toBe(true);
        };
        await work.processor.execute(request);
        expect(work.rpc.reads.getOrderStatus).toBe(110);
        expect(newId).toBeDefined();
        expect(
            db.prepare("SELECT validated_at FROM orders WHERE id=?").get(newId),
        ).toEqual({ validated_at: 0 });
        work.rpc.onRead = undefined;
        await work.processor.execute({
            ...request,
            jobId: "new-trigger",
            origin: { ...origin, sequence: 11 },
        });
        expect(
            db.prepare("SELECT validated_at FROM orders WHERE id=?").get(newId),
        ).toEqual({ validated_at: HEAVY_MAKER.now });
    });
});
