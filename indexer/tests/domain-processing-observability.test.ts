import { afterEach, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    observeProcessing,
    observeSyncProcessing,
} from "../src/application/processing-observability.js";
import { ORDER_PROCESSING_OPERATION as OPERATION } from "../src/application/orders/observability.js";
import { DomainProcessingMetrics } from "../src/infra/observability/domain-processing-metrics.js";
import {
    DOMAIN_PROCESSING_METRIC as METRIC,
    DOMAIN_PROCESSING_METRIC_LABEL as LABEL,
    DOMAIN_PROCESSING_RESULT as RESULT,
    PROCESSING_DURATION_BUCKETS_SECONDS,
} from "../src/infra/observability/domain-processing-metric-contract.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { processingTelemetry } from "./helpers/processing-observability.js";

afterEach(() => vi.restoreAllMocks());

it("exports overlapping work and errors with correct duration units, bounded labels and balanced gauges", async () => {
    let now = 1_000;
    const telemetry = await processingTelemetry(() => now);
    const pending = Promise.withResolvers<void>();
    const failure = new Error("original validation error");
    const labels = { [LABEL.Operation]: OPERATION.DemandBatch };
    const first = observeProcessing(
        telemetry.hooks,
        OPERATION.DemandBatch,
        { orderId: "fixture-order-not-a-metric-label", runId: "fixture-run" },
        async () => pending.promise,
    );
    await expect(
        observeProcessing(
            telemetry.hooks,
            OPERATION.DemandBatch,
            {},
            async () => {
                now += 500;
                throw failure;
            },
        ),
    ).rejects.toBe(failure);
    expect(await telemetry.value(METRIC.Active, labels)).toBe(1);
    now += 1000;
    pending.resolve();
    await first;
    expect(await telemetry.value(METRIC.Active, labels)).toBe(0);
    expect(
        await telemetry.value(METRIC.Operations, {
            ...labels,
            [LABEL.Result]: RESULT.Failure,
        }),
    ).toBe(1);
    expect(
        await telemetry.value(`${METRIC.Duration}_sum`, {
            ...labels,
            [LABEL.Result]: RESULT.Success,
        }),
    ).toBe(1.5);
    expect(
        await telemetry.value(`${METRIC.Duration}_sum`, {
            ...labels,
            [LABEL.Result]: RESULT.Failure,
        }),
    ).toBe(0.5);
    expect(telemetry.apm.spans.map((span) => span.error)).toEqual([
        undefined,
        failure,
    ]);
    expect(telemetry.apm.spans.every((span) => span.finished)).toBe(true);
    telemetry.observer.started("dynamic-order-should-not-be-a-series")(true);
    const scrape = await telemetry.metrics.metricsText();
    expect(scrape).not.toContain("fixture-order");
    expect(scrape).not.toContain("fixture-run");
    expect(scrape).not.toContain("dynamic-order");
    expect(scrape).not.toContain("artgod_indexer_artgod_indexer");
    for (const bucket of PROCESSING_DURATION_BUCKETS_SECONDS)
        expect(scrape).toContain(`le="${bucket}"`);
    const allowed = new Set([
        "worker",
        "chain_id",
        LABEL.Operation,
        LABEL.Result,
        "le",
    ]);
    for (const line of scrape
        .split("\n")
        .filter((line) => !line.startsWith("#")))
        for (const match of line.matchAll(/(\w+)="/g))
            expect(allowed.has(match[1]!)).toBe(true);
});

it("keeps FIFO permits and wait metrics accurate through cancellation, work failure and final drain", async () => {
    let now = 0;
    const telemetry = await processingTelemetry(() => now);
    const admission = new FairOrderValidationAdmission(
        1,
        telemetry.hooks,
        () => now,
    );
    const pending = Promise.withResolvers<void>();
    const controller = new AbortController();
    const started: string[] = [];
    const first = admission.run(async () => pending.promise);
    const cancelledWork = vi.fn(async () => {});
    const second = admission
        .run(cancelledWork, controller.signal)
        .catch((error) => error);
    const third = admission
        .run(async () => {
            started.push("oldest");
            throw new Error("work failure");
        })
        .catch((error) => error);
    expect(await telemetry.value(METRIC.AdmissionActive)).toBe(1);
    expect(await telemetry.value(METRIC.AdmissionWaiting)).toBe(2);
    now = 1000;
    controller.abort();
    await second;
    expect(await telemetry.value(METRIC.AdmissionWaiting)).toBe(1);
    expect(cancelledWork).not.toHaveBeenCalled();
    expect(
        await telemetry.value(`${METRIC.AdmissionWait}_sum`, {
            [LABEL.Result]: RESULT.Cancelled,
        }),
    ).toBe(1);
    now = 2000;
    pending.resolve();
    const fourth = admission.run(async () => {
        started.push("newcomer");
    });
    await Promise.all([first, third, fourth]);
    expect(started).toEqual(["oldest", "newcomer"]);
    expect(await telemetry.value(METRIC.AdmissionActive)).toBe(0);
    expect(await telemetry.value(METRIC.AdmissionWaiting)).toBe(0);
    expect(await telemetry.value(METRIC.AdmissionCapacity)).toBe(1);
    expect(
        await telemetry.value(`${METRIC.AdmissionWait}_count`, {
            [LABEL.Result]: RESULT.Granted,
        }),
    ).toBe(3);
    const waits = telemetry.apm.spans.filter(
        (span) => span.name === OPERATION.ValidationWait,
    );
    expect(waits).toHaveLength(3);
    expect(waits[0]?.error).toBe(controller.signal.reason);
    expect(waits.every((span) => span.finished)).toBe(true);
});

it("preserves results and original failures when metrics throw, including after synchronous commit", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fail = () => {
        throw new Error("metrics unavailable");
    };
    const metrics: Metrics = { increment: fail, gauge: fail, histogram: fail };
    const observer = new DomainProcessingMetrics(metrics);
    const hooks = { observer };
    const failure = new Error("original business failure");
    let writes = 0;
    expect(
        observeSyncProcessing(
            hooks,
            OPERATION.DemandCommit,
            {},
            () => ++writes,
        ),
    ).toBe(1);
    expect(() =>
        observeSyncProcessing(hooks, OPERATION.MakerCheckpoint, {}, () => {
            throw failure;
        }),
    ).toThrow(failure);
    await expect(
        observeProcessing(
            hooks,
            OPERATION.DemandBatch,
            {},
            async () => ++writes,
        ),
    ).resolves.toBe(2);
    await expect(
        observeProcessing(hooks, OPERATION.DemandBatch, {}, async () => {
            throw failure;
        }),
    ).rejects.toBe(failure);
    const admission = new FairOrderValidationAdmission(1, hooks);
    await expect(admission.run(async () => 3)).resolves.toBe(3);
    await expect(
        admission.run(async () => {
            throw failure;
        }),
    ).rejects.toBe(failure);
    await expect(admission.run(async () => 4)).resolves.toBe(4);
    expect(writes).toBe(2);
});
