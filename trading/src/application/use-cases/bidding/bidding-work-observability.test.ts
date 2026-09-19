import { describe, expect, it } from "vitest";
import {
    BIDDING_WORK_STAGE,
    observeBiddingWork,
} from "./bidding-work-observability.js";

describe("observeBiddingWork", () => {
    it("cannot replace business results or errors with observer failures", async () => {
        const error = new Error("business error");
        const observer = {
            onWorkStarted() {
                throw new Error("observer error");
            },
        };
        await expect(
            observeBiddingWork(
                observer,
                BIDDING_WORK_STAGE.Command,
                async () => 7,
            ),
        ).resolves.toBe(7);
        await expect(
            observeBiddingWork(
                observer,
                BIDDING_WORK_STAGE.Command,
                async () => {
                    throw error;
                },
            ),
        ).rejects.toBe(error);
        await expect(
            observeBiddingWork(
                {
                    onWorkStarted: () => () => {
                        throw new Error("finish error");
                    },
                },
                BIDDING_WORK_STAGE.Command,
                async () => 8,
            ),
        ).resolves.toBe(8);
    });

    it("does not label a handled failed command as successful work", async () => {
        const results: boolean[] = [];
        const result = await observeBiddingWork(
            {
                onWorkStarted: () => (success) => {
                    results.push(success);
                },
            },
            BIDDING_WORK_STAGE.Command,
            async () => false,
            (success) => success,
        );
        expect(result).toBe(false);
        expect(results).toEqual([false]);
    });
});
