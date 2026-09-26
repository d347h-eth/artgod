import { afterEach, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import { ORDER_VALIDATION_DEMAND_LOG as LOG } from "../src/domain/order-validation-demand.js";
import {
    OrderValidationDemandProgress,
    ORDER_VALIDATION_REPORTING_POLICY as POLICY,
} from "../src/infra/orders/order-validation-demand-reporting.js";
import type { OrderValidationBatchReport } from "../src/application/orders/validate-order-demand.js";

afterEach(() => vi.restoreAllMocks());

it("reports actual validations separately from durable effects, skips and retries in bounded windows", () => {
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    let now = 100_000;
    const progress = new OrderValidationDemandProgress(1, () => now);
    const batch: OrderValidationBatchReport = {
        scanned: 100,
        claimed: 80,
        validated: 65,
        applied: 60,
        covered: 55,
        resolvedUnneeded: 21,
        followup: 8,
        retried: 3,
        released: 10,
        lostClaims: 3,
        oldestRequiredAt: 50_000,
        durationMs: 900,
        contractReads: { perOrder: 80, shared: 3, other: 0, statusBatches: 4 },
    };
    for (let i = 0; i < 100; i++) progress.record(batch);
    expect(log).not.toHaveBeenCalled();
    now += POLICY.intervalMs;
    progress.record(undefined);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(LOG.Progress, {
        component: LOG.Component,
        chainId: 1,
        startedAt: 100_000,
        endedAt: now,
        windowMs: POLICY.intervalMs,
        batches: 100,
        scanned: 10000,
        claimed: 8000,
        validated: 6500,
        applied: 6000,
        covered: 5500,
        resolvedUnneeded: 2100,
        followup: 800,
        retried: 300,
        released: 1000,
        lostClaims: 300,
        batchDurationMs: 90000,
        maximumBatchDurationMs: 900,
        oldestSampledRequiredAt: 50000,
        contractReads: {
            perOrder: 8000,
            shared: 300,
            other: 0,
            statusBatches: 400,
        },
    });
    progress.record({
        ...batch,
        contractReads: null,
        oldestRequiredAt: 60_000,
    });
    now += 50;
    progress.flush();
    expect(log).toHaveBeenLastCalledWith(
        LOG.Progress,
        expect.objectContaining({
            batches: 1,
            scanned: 100,
            windowMs: 50,
            oldestSampledRequiredAt: 60000,
            contractReads: {
                perOrder: 0,
                shared: 0,
                other: 0,
                statusBatches: 0,
            },
        }),
    );
    progress.flush();
    now += POLICY.intervalMs;
    progress.record(undefined);
    expect(log).toHaveBeenCalledTimes(2);
});
