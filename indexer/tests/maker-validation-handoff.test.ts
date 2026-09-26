import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import {
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MakerRevalidationConflict,
} from "../src/domain/maker-revalidation.js";
import { ORDER_VALIDATION_DEMAND_POLICY as DEMAND_POLICY } from "../src/domain/order-validation-demand.js";
import { OrderValidationReadUnavailable } from "../src/domain/order-validation-failure.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { inspectOrderProcessing } from "../scripts/order-processing-inspection.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerHint,
    seedHeavyMaker,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { processingTelemetry } from "./helpers/processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION as OPERATION,
    ORDER_VALIDATION_BATCH_OUTCOME as DEMAND_OUTCOME,
    type OrderProcessingObservability,
} from "../src/application/orders/observability.js";
import {
    DOMAIN_PROCESSING_METRIC as METRIC,
    DOMAIN_PROCESSING_METRIC_LABEL as LABEL,
    DOMAIN_PROCESSING_RESULT as RESULT,
    MAKER_CHECKPOINT_OUTCOME as OUTCOME,
} from "../src/infra/observability/domain-processing-metric-contract.js";

const now = HEAVY_MAKER.now * 1000;
const origin = {
    streamId: "handoff-fixture",
    consumerName: "handoff-maker",
    sequence: 1,
};
const request = {
    jobId: "maker-handoff",
    payload: heavyMakerHint(),
    origin,
    requiredAt: now,
};
type Input = Parameters<RevalidateMakerOrders["execute"]>[0];

function workflow(
    rpc = new HeavyMakerRpc(),
    observability?: OrderProcessingObservability,
) {
    const orders = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
        throw new Error("Handoff must use strict snapshots");
    });
    const demand = new SqliteOrderValidationDemand(orders);
    const store = new SqliteMakerRevalidations(orders, demand);
    const admission = new FairOrderValidationAdmission(2);
    const createSnapshot = createSeaportOrderValidationFactory({
        chainId: HEAVY_MAKER.chainId,
        rpc,
        conduits: warmConduits,
        conduitController: HEAVY_MAKER.controller,
    });
    return {
        rpc,
        demand,
        store,
        processor: new RevalidateMakerOrders({
            store,
            admission,
            createSnapshot,
            observability,
        }),
        validator: new ValidateOrderDemand({
            chainId: HEAVY_MAKER.chainId,
            store: demand,
            admission,
            createSnapshot,
            observability,
        }),
    };
}
type Work = ReturnType<typeof workflow>;
const saved = (work: Work, input: Input = request) =>
    work.store.admit({ ...input, now: Date.now() });

async function next(work: Work, input: Input = request) {
    const run = saved(work, input);
    if (run.wakeupOutboxId === null) await work.processor.execute(input);
    else {
        const row = db
            .prepare("SELECT job_json FROM queue_outbox WHERE outbox_id=?")
            .get(run.wakeupOutboxId) as { job_json: string };
        const job = JSON.parse(row.job_json);
        await work.processor.execute({
            jobId: job.jobId,
            payload: job.payload,
            origin,
        });
    }
    return saved(work, input);
}

async function finish(work: Work, input: Input = request) {
    for (
        let steps = 0;
        saved(work, input).status !== STATUS.Completed;
        steps++
    ) {
        if (steps > 100)
            throw new Error("Maker fixture did not finish its bounded scan");
        await next(work, input);
    }
    return saved(work, input);
}

function failOrder(work: Work, orderId: string) {
    work.rpc.onRead = ({ functionName, args }) => {
        if (functionName === "getOrderStatus" && args?.[0] === orderId)
            throw new Error("Fixture persistent order read failure");
    };
}

async function isolate(work: Work, orderId: string, input: Input = request) {
    failOrder(work, orderId);
    for (let attempt = 0; attempt < POLICY.isolateAfterFailures; attempt++)
        await expect(next(work, input)).rejects.toThrow(
            OrderValidationReadUnavailable,
        );
    expect(saved(work, input).isolateOrderId).toBe(orderId);
}

describe("maker scan handoff to durable order validation", () => {
    loadTestEnv();
    let dbPath: string;
    beforeAll(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["debug", "info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        db.exec(
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
        );
    });
    afterEach(() => vi.restoreAllMocks());

    it("finishes healthy orders past a persistent failure, survives restart, and later completes the isolated demand", async () => {
        seedHeavyMaker(250);
        const telemetry = await processingTelemetry();
        const first = workflow(undefined, telemetry.hooks);
        const bad = first.store.next(saved(first), 100)[40]!.order;
        await isolate(first, bad.id);
        expect(await next(first)).toMatchObject({
            resolvedOrders: 40,
            deferredOrders: 0,
            isolateOrderId: bad.id,
        });
        const inspection = inspectOrderProcessing(
            { databasePath: dbPath, chainId: 1, limit: 3, counts: true },
            now,
        );
        expect(inspection.makerSample[0]).toMatchObject({
            isolateOrderId: bad.id,
            deferredOrders: 0,
        });

        setDbPath(dbPath);
        const restarted = workflow(undefined, telemetry.hooks);
        failOrder(restarted, bad.id);
        const completed = await finish(restarted);
        expect(completed).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 249,
            deferredOrders: 1,
            isolateOrderId: null,
        });
        expect(
            await telemetry.value(METRIC.MakerOrders, {
                [LABEL.Outcome]: OUTCOME.Resolved,
            }),
        ).toBe(249);
        expect(
            await telemetry.value(METRIC.MakerOrders, {
                [LABEL.Outcome]: OUTCOME.Deferred,
            }),
        ).toBe(1);
        expect(
            await telemetry.value(METRIC.MakerOrders, {
                [LABEL.Outcome]: OUTCOME.Validated,
            }),
        ).toBe(249);
        const handoff = telemetry.apm.spans.find(
            (span) =>
                span.name === OPERATION.MakerValidate &&
                span.attributes.isolated === true,
        );
        expect(handoff?.error).toBeInstanceOf(OrderValidationReadUnavailable);
        expect(handoff?.parent?.name).toBe(OPERATION.MakerStep);
        expect(handoff?.parent?.error).toBeUndefined();
        expect(handoff?.parent?.finished).toBe(true);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE maker=? AND validated_at>0",
                )
                .get(HEAVY_MAKER.maker),
        ).toEqual({ count: 249 });
        expect(
            db
                .prepare(
                    "SELECT validated_at,fillability_status FROM orders WHERE id=?",
                )
                .get(bad.id),
        ).toEqual({
            validated_at: 0,
            fillability_status: bad.fillabilityStatus,
        });
        const obligation = restarted.demand.get(1, bad.id)!;
        expect(obligation).toMatchObject({
            pending: true,
            requiredAt: now,
            minimumBlock: request.payload.blockNumber,
            proofRevision: null,
            failures: DEMAND_POLICY.isolateAfterFailures,
        });
        const reads = restarted.rpc.reads.getOrderStatus;
        await restarted.processor.execute(request); // lost source ACK
        await restarted.processor.execute({
            ...request,
            jobId: "compatible-older-hint",
            requiredAt: now - 1,
        });
        expect(restarted.rpc.reads.getOrderStatus).toBe(reads);
        expect(restarted.demand.get(1, bad.id)).toEqual(obligation);

        vi.mocked(Date.now).mockReturnValue(now + DEMAND_POLICY.retryBaseMs);
        expect(await restarted.validator.executeBatch()).toMatchObject({
            claimed: 1,
            covered: 0,
            retried: 1,
        });
        expect(restarted.demand.get(1, bad.id)).toMatchObject({
            pending: true,
            proofRevision: null,
        });
        restarted.rpc.onRead = undefined;
        vi.mocked(Date.now).mockReturnValue(now + DEMAND_POLICY.retryMaxMs + 1);
        restarted.rpc.blockTimestamp = Math.floor(Date.now() / 1000);
        expect(await restarted.validator.executeBatch()).toMatchObject({
            covered: 1,
            retried: 0,
        });
        expect(restarted.demand.get(1, bad.id)).toMatchObject({
            pending: false,
            failures: 0,
        });
        expect(
            await telemetry.value(METRIC.DemandOrders, {
                [LABEL.Outcome]: DEMAND_OUTCOME.Retried,
            }),
        ).toBe(1);
        expect(
            await telemetry.value(METRIC.DemandOrders, {
                [LABEL.Outcome]: DEMAND_OUTCOME.Covered,
            }),
        ).toBe(1);
        expect(
            await telemetry.value(METRIC.MakerOrders, {
                [LABEL.Outcome]: OUTCOME.Deferred,
            }),
        ).toBe(1);
    });

    it.each(["checkpoint", "continuation"])(
        "rolls back both cursor and demand when the %s write fails, then retains demand after maker cleanup",
        async (fault) => {
            seedHeavyMaker(3);
            const input = { ...request, requiredAt: undefined };
            const telemetry = await processingTelemetry();
            const work = workflow(undefined, telemetry.hooks);
            const bad = work.store.next(saved(work, input), 1)[0]!.order;
            await isolate(work, bad.id, input);
            const trigger =
                fault === "checkpoint"
                    ? "BEFORE UPDATE OF deferred_orders ON maker_order_revalidation_runs WHEN NEW.deferred_orders>OLD.deferred_orders"
                    : "BEFORE INSERT ON queue_outbox";
            db.exec(
                `CREATE TEMP TRIGGER reject_handoff ${trigger} BEGIN SELECT RAISE(ABORT,'fixture handoff write failed'); END;`,
            );
            try {
                await expect(next(work, input)).rejects.toThrow(
                    "fixture handoff write failed",
                );
                expect(saved(work, input)).toMatchObject({
                    afterId: "",
                    resolvedOrders: 0,
                    deferredOrders: 0,
                    isolateOrderId: bad.id,
                });
                expect(work.demand.get(1, bad.id)).toBeNull();
                expect(
                    db
                        .prepare("SELECT COUNT(*) AS count FROM queue_outbox")
                        .get(),
                ).toEqual({ count: 0 });
                expect(await telemetry.metrics.metricsText()).not.toContain(
                    `artgod_indexer_${METRIC.MakerOrders}`,
                );
                expect(
                    await telemetry.value(METRIC.Operations, {
                        [LABEL.Operation]: OPERATION.MakerCheckpoint,
                        [LABEL.Result]: RESULT.Failure,
                    }),
                ).toBe(1);
            } finally {
                db.exec("DROP TRIGGER reject_handoff");
            }
            const committed = await next(work, input);
            expect(committed).toMatchObject({
                afterId: bad.id,
                deferredOrders: 1,
            });
            expect(
                await telemetry.value(METRIC.MakerOrders, {
                    [LABEL.Outcome]: OUTCOME.Deferred,
                }),
            ).toBe(1);
            setDbPath(dbPath);
            const restarted = workflow();
            const visited: unknown[] = [];
            restarted.rpc.onRead = ({ functionName, args }) => {
                if (functionName === "getOrderStatus") visited.push(args?.[0]);
            };
            await finish(restarted, input);
            expect(visited).not.toContain(bad.id);
            expect(
                restarted.store.cleanup(
                    { ...origin, ackFloor: origin.sequence },
                    100,
                ),
            ).toBe(1);
            expect(restarted.store.get(committed.runId)).toBeUndefined();
            expect(restarted.demand.get(1, bad.id)?.pending).toBe(true);
            expect(
                restarted.store.resume({
                    runId: committed.runId,
                    step: committed.step,
                    chainId: 1,
                    origin,
                }),
            ).toBeNull();
            vi.mocked(Date.now).mockReturnValue(
                now + DEMAND_POLICY.retryBaseMs,
            );
            expect(await restarted.validator.executeBatch()).toMatchObject({
                covered: 1,
            });
        },
    );

    it("strengthens the current revision without weakening newer demand or stealing its lease", async () => {
        seedHeavyMaker(1);
        const work = workflow();
        const bad = work.store.next(saved(work), 1)[0]!.order;
        await isolate(work, bad.id);
        const newer = {
            chainId: 1,
            orderId: bad.id,
            requiredAt: now + 100,
            minimumBlock: HEAVY_MAKER.blockNumber + 10,
        };
        work.demand.admit(newer, now);
        const claim = work.demand.claimBatch(1, "existing-demand-executor", now)
            .claims[0]!;
        db.prepare(
            "UPDATE orders SET state_revision=state_revision+1 WHERE id=?",
        ).run(bad.id);
        await finish(work);
        expect(work.demand.get(1, bad.id)).toMatchObject({
            ...newer,
            pending: true,
            revision: claim.candidate.revision + 1,
            leaseOwner: claim.demand.leaseOwner,
            leaseVersion: claim.demand.leaseVersion,
        });
        expect(
            work.demand.completeBatch(
                [
                    {
                        claim,
                        result: {
                            status: ORDER_STATUS.Fillable,
                            reason: "stale executor",
                        },
                    },
                ],
                {
                    observedAt: newer.requiredAt,
                    blockNumber: newer.minimumBlock,
                },
                now,
            ),
        ).toMatchObject({ covered: 0, followup: 1 });
        expect(work.demand.get(1, bad.id)).toMatchObject({
            pending: true,
            proofRevision: null,
        });
    });

    it("runs a newer maker generation after a deferred scan and strengthens the unfinished order", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        const bad = work.store.next(saved(work), 1)[0]!.order;
        await isolate(work, bad.id);
        const first = await finish(work);
        const later = now + 1000;
        const input = {
            ...request,
            jobId: "newer-maker-trigger",
            requiredAt: later,
            payload: {
                ...request.payload,
                blockNumber: HEAVY_MAKER.blockNumber + 10,
            },
        };
        vi.mocked(Date.now).mockReturnValue(later);
        work.rpc.blockNumber = input.payload.blockNumber;
        work.rpc.blockTimestamp = Math.floor(later / 1000);
        await isolate(work, bad.id, input);
        const second = await finish(work, input);
        expect(second).toMatchObject({
            runId: first.runId,
            generation: 2,
            passGeneration: 2,
            resolvedOrders: 4,
            deferredOrders: 2,
        });
        expect(work.demand.get(1, bad.id)).toMatchObject({
            pending: true,
            requiredAt: later,
            minimumBlock: input.payload.blockNumber,
            proofRevision: null,
        });
        await work.processor.execute(request); // old source replay must not erase newer demand
        expect(work.demand.get(1, bad.id)?.requiredAt).toBe(later);
    });

    it("preserves a newer maker trigger arriving during the final failed read", async () => {
        seedHeavyMaker(1);
        const work = workflow();
        const bad = work.store.next(saved(work), 1)[0]!.order;
        await isolate(work, bad.id);
        const later = now + 1000;
        const newer = {
            ...request,
            jobId: "concurrent-maker-trigger",
            requiredAt: later,
            payload: {
                ...request.payload,
                blockNumber: HEAVY_MAKER.blockNumber + 10,
            },
        };
        work.rpc.onRead = ({ functionName }) => {
            if (functionName !== "getOrderStatus") return;
            vi.mocked(Date.now).mockReturnValue(later);
            saved(work, newer);
            throw new Error("Failed read while a newer trigger arrived");
        };
        expect(await next(work)).toMatchObject({
            status: STATUS.Pending,
            afterId: "",
            generation: 2,
            passGeneration: 2,
            deferredOrders: 1,
            passStartedAt: later,
        });
        work.rpc.blockNumber = newer.payload.blockNumber;
        work.rpc.blockTimestamp = Math.floor(later / 1000);
        await isolate(work, bad.id);
        expect(await finish(work)).toMatchObject({
            status: STATUS.Completed,
            deferredOrders: 2,
        });
        expect(work.demand.get(1, bad.id)).toMatchObject({
            pending: true,
            requiredAt: later,
            minimumBlock: newer.payload.blockNumber,
            proofRevision: null,
        });
    });

    it.each(["removed", "cancelled", "pre-anchor"])(
        "resolves a now-%s order without manufacturing a deferred obligation",
        async (change) => {
            seedHeavyMaker(1);
            const work = workflow();
            const bad = work.store.next(saved(work), 1)[0]!.order;
            await isolate(work, bad.id);
            work.rpc.onRead = ({ functionName }) => {
                if (functionName !== "getOrderStatus") return;
                if (change === "removed")
                    db.prepare("DELETE FROM orders WHERE id=?").run(bad.id);
                else if (change === "cancelled")
                    db.prepare(
                        "UPDATE orders SET source_status=? WHERE id=?",
                    ).run(ORDER_SOURCE_STATUS.Cancelled, bad.id);
                else
                    db.prepare(
                        "UPDATE collections SET bootstrap_anchor_block=? WHERE chain_id=1 AND collection_id=?",
                    ).run(HEAVY_MAKER.blockNumber, bad.collectionId);
                throw new Error("Fixture read failed after state changed");
            };
            expect(await finish(work)).toMatchObject({
                status: STATUS.Completed,
                resolvedOrders: 1,
                deferredOrders: 0,
            });
            expect(work.demand.get(1, bad.id)).toBeNull();
        },
    );

    it.each([
        "shared-read",
        "registry",
        "snapshot-creation",
        "snapshot-finish",
    ])("retains the isolated maker cursor on %s failure", async (fault) => {
        seedHeavyMaker(1);
        const work = workflow();
        const bad = work.store.next(saved(work), 1)[0]!.order;
        await isolate(work, bad.id);
        work.rpc.onRead = ({ functionName }) => {
            if (fault === "shared-read" && functionName === "getCounter")
                throw new Error("shared RPC failure");
        };
        if (fault === "registry")
            vi.spyOn(warmConduits, "getConduit").mockImplementation(() => {
                throw new Error("storage failure");
            });
        if (fault === "snapshot-creation")
            vi.spyOn(work.rpc, "getBlockNumber").mockRejectedValue(
                new Error("head unavailable"),
            );
        if (fault === "snapshot-finish") {
            const getBlock = work.rpc.getBlock.bind(work.rpc);
            let reads = 0;
            vi.spyOn(work.rpc, "getBlock").mockImplementation(
                async (number) => {
                    if (++reads === 2)
                        throw new Error("canonicality unavailable");
                    return getBlock(number);
                },
            );
        }
        await expect(next(work)).rejects.toThrow();
        expect(saved(work)).toMatchObject({
            afterId: "",
            resolvedOrders: 0,
            deferredOrders: 0,
            isolateOrderId: bad.id,
        });
        expect(work.demand.get(1, bad.id)).toBeNull();
        expect(
            db
                .prepare("SELECT validated_at FROM orders WHERE id=?")
                .get(bad.id),
        ).toEqual({ validated_at: 0 });
    });

    it("fences a lost maker lease before admitting any deferred work", async () => {
        seedHeavyMaker(1);
        const work = workflow();
        const bad = work.store.next(saved(work), 1)[0]!.order;
        await isolate(work, bad.id);
        const claimed = work.store.claim(
            saved(work).runId,
            "stale-maker",
            now,
        )!;
        vi.mocked(Date.now).mockReturnValue(now + POLICY.leaseMs + 1);
        work.store.claim(claimed.runId, "new-maker", Date.now());
        const candidate = work.store.next(claimed, 1)[0]!;
        expect(() =>
            work.store.checkpoint(
                claimed,
                [{ candidate, deferredError: "fixture failed read" }],
                true,
                Date.now(),
            ),
        ).toThrow(MakerRevalidationConflict);
        expect(work.demand.get(1, bad.id)).toBeNull();
        expect(saved(work).afterId).toBe("");
    });
});
