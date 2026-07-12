import { describe, expect, it } from "vitest";
import {
    TRADING_BIDDING_AUTHORIZATION_STATUS,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    resolveTradingBiddingAuthorizationJobPhase,
} from "./trading.js";

describe("resolveTradingBiddingAuthorizationJobPhase", () => {
    it.each([
        [
            TRADING_BIDDING_AUTHORIZATION_STATUS.Inactive,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.WaitingForBot,
        ],
        [
            TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.AuthorizationRequired,
        ],
        [
            TRADING_BIDDING_AUTHORIZATION_STATUS.UpdateRequired,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.AuthorizationRequired,
        ],
        [
            TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable,
            TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.AuthorizationUnavailable,
        ],
        [TRADING_BIDDING_AUTHORIZATION_STATUS.Included, null],
    ])("maps %s to %s", (status, expectedPhase) => {
        expect(resolveTradingBiddingAuthorizationJobPhase(status)).toBe(
            expectedPhase,
        );
    });
});
