import { describe, expect, it } from "vitest";
import type { Metrics } from "@artgod/shared/observability/metrics";
import { InFlightMetrics } from "./in-flight-metrics.js";
import {
    BIDDING_RUNTIME_METRIC_LABEL as label,
    BIDDING_RUNTIME_METRIC_NAME as name,
} from "./bidding-runtime-metric-contract.js";
import { BIDDING_WORK_STAGE } from "../../application/use-cases/bidding/bidding-work-observability.js";

describe("InFlightMetrics", () => {
    it("retains the oldest concurrent start, distinguishes identical timestamps, and clears finished work", () => {
        let now = 10_000;
        const values = new Map<string, number>();
        const metrics: Metrics = {
            increment() {},
            histogram() {},
            gauge(key, value) {
                values.set(key, value);
            },
        };
        const tracker = new InFlightMetrics(
            metrics,
            {
                active: name.WorkActive,
                oldestStart: name.WorkOldestStart,
                lastProgress: name.WorkLastProgress,
                lastSuccess: name.WorkLastSuccess,
            },
            () => now,
        );
        const labels = { [label.Stage]: BIDDING_WORK_STAGE.PlaceOffer };
        const first = tracker.start(labels);
        const second = tracker.start(labels);
        now = 20_000;
        const third = tracker.start(labels);
        second(false);
        expect(values.get(name.WorkActive)).toBe(2);
        expect(values.get(name.WorkOldestStart)).toBe(10);
        expect(values.get(name.WorkLastSuccess)).toBe(0);
        first(true);
        first(true);
        expect(values.get(name.WorkActive)).toBe(1);
        expect(values.get(name.WorkOldestStart)).toBe(20);
        expect(values.get(name.WorkLastSuccess)).toBe(20);
        now = 30_000;
        third(false);
        expect(values.get(name.WorkActive)).toBe(0);
        expect(values.get(name.WorkOldestStart)).toBe(0);
        expect(values.get(name.WorkLastProgress)).toBe(30);
        expect(values.get(name.WorkLastSuccess)).toBe(20);
    });
});
