import { strict as assert } from "node:assert";
import { logger } from "@artgod/shared/utils/logger";
import { afterEach, describe, it, vi } from "vitest";
import {
    BIDDING_LOG_COMPONENT,
    biddingLog,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "./bidding-log.js";

describe("biddingLog", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits unprefixed structured messages with component and action fields", () => {
        const warnSpy = vi
            .spyOn(logger, "warn")
            .mockImplementation(() => undefined);
        const log = createBiddingComponentLogger(
            BIDDING_LOG_COMPONENT.Bidder,
        );

        log.warn("refreshJob", "Bidding job refresh failed", {
            jobId: "job-1",
        });

        assert.equal(warnSpy.mock.calls.length, 1);
        assert.deepEqual(warnSpy.mock.calls[0], [
            "Bidding job refresh failed",
            {
                jobId: "job-1",
                component: "Bidder",
                action: "refreshJob",
            },
        ]);
    });

    it("keeps component and action owned by the component logger", () => {
        const errorSpy = vi
            .spyOn(logger, "error")
            .mockImplementation(() => undefined);
        const log = createBiddingComponentLogger(
            BIDDING_LOG_COMPONENT.OpenSeaBiddingService,
        );

        log.error("submitBid", "OpenSea bid submission failed", {
            component: "WrongComponent",
            action: "wrongAction",
            orderHash: "0xabc",
        });

        assert.deepEqual(errorSpy.mock.calls[0]?.[1], {
            orderHash: "0xabc",
            component: "OpenSeaBiddingService",
            action: "submitBid",
        });
    });

    it("keeps the direct logger path structured", () => {
        const errorSpy = vi
            .spyOn(logger, "error")
            .mockImplementation(() => undefined);

        biddingLog.error("Trading bot startup failed", {
            component: BIDDING_LOG_COMPONENT.BiddingBotRuntime,
            action: "startupFailed",
            botKind: "bidding",
        });

        assert.deepEqual(errorSpy.mock.calls[0], [
            "Trading bot startup failed",
            {
                botKind: "bidding",
                component: "BiddingBotRuntime",
                action: "startupFailed",
            },
        ]);
    });

    it("normalizes unknown errors into payload fields", () => {
        assert.deepEqual(toErrorLogFields(new TypeError("boom")), {
            errorName: "TypeError",
            errorMessage: "boom",
        });
        assert.deepEqual(toErrorLogFields("boom"), {
            errorMessage: "boom",
        });
    });
});
