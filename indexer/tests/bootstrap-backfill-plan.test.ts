import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_BACKFILL_PLAN_KIND,
    resolveBootstrapBackfillPlan,
} from "../src/application/bootstrap-backfill-plan.js";

describe("bootstrap backfill plan", () => {
    it("finishes without catch-up when head is before the post-anchor range", () => {
        expect(
            resolveBootstrapBackfillPlan({
                fromBlock: 101,
                headBlock: 100,
            }),
        ).toEqual({
            kind: BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks,
            fromBlock: 101,
            headBlock: 100,
        });
    });

    it("queues a single-block range when head equals the first post-anchor block", () => {
        expect(
            resolveBootstrapBackfillPlan({
                fromBlock: 101,
                headBlock: 101,
            }),
        ).toEqual({
            kind: BOOTSTRAP_BACKFILL_PLAN_KIND.QueueBackfill,
            fromBlock: 101,
            toBlock: 101,
            totalBlocks: 1,
        });
    });

    it("queues the full post-anchor range through current head", () => {
        expect(
            resolveBootstrapBackfillPlan({
                fromBlock: 101,
                headBlock: 105,
            }),
        ).toEqual({
            kind: BOOTSTRAP_BACKFILL_PLAN_KIND.QueueBackfill,
            fromBlock: 101,
            toBlock: 105,
            totalBlocks: 5,
        });
    });
});
