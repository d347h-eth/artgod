import { describe, expect, it } from "vitest";
import {
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION as POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT as CONSTRAINT,
} from "../types/trading.js";
import {
    biddingBidBookOwnStates,
    bidMatchesOwnStateFilter,
    countBiddingBidBookOwnStates,
    type BiddingBidBookOwnStateSignals,
} from "./bid-book-own-state.js";

const market: BiddingBidBookOwnStateSignals = {
    isOwn: true,
    materialization: { kind: MATERIALIZATION.MarketBid, phase: null },
    ownStatus: null,
};

describe("own bid-book states", () => {
    it("uses authoritative decisions, deduplicates constraints and supersedes intent phases", () => {
        const bid: BiddingBidBookOwnStateSignals = {
            ...market,
            materialization: {
                kind: MATERIALIZATION.OwnJobIntent,
                phase: PHASE.Verifying,
            },
            ownStatus: {
                position: POSITION.Losing,
                constraints: [CONSTRAINT.Ceiling, CONSTRAINT.Ceiling],
            },
        };
        expect(biddingBidBookOwnStates(bid)).toEqual([
            POSITION.Losing,
            CONSTRAINT.Ceiling,
        ]);
        expect(bidMatchesOwnStateFilter(bid, POSITION.Losing)).toBe(true);
        expect(bidMatchesOwnStateFilter(bid, CONSTRAINT.Ceiling)).toBe(true);
        expect(bidMatchesOwnStateFilter(bid, PHASE.Verifying)).toBe(false);
        expect(biddingBidBookOwnStates({ ...bid, isOwn: false })).toEqual([]);
    });

    it("counts pending intents and overlapping positions and limits without assigning unknown market states", () => {
        const bids: BiddingBidBookOwnStateSignals[] = [
            ...[
                PHASE.WaitingForBot,
                PHASE.Verifying,
                PHASE.Queued,
                PHASE.Paused,
            ].map((phase) => ({
                ...market,
                materialization: { kind: MATERIALIZATION.OwnJobIntent, phase },
            })),
            {
                ...market,
                ownStatus: {
                    position: POSITION.Winning,
                    constraints: [CONSTRAINT.Floor],
                },
            },
            {
                ...market,
                ownStatus: {
                    position: POSITION.Losing,
                    constraints: [CONSTRAINT.Ceiling],
                },
            },
            {
                ...market,
                ownStatus: { position: POSITION.Draw, constraints: [] },
            },
            market,
            { ...market, isOwn: false },
        ];
        const counts = countBiddingBidBookOwnStates(bids.values());
        expect(counts.total).toBe(8);
        expect(Object.values(counts.states)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
        expect(biddingBidBookOwnStates(market)).toEqual([]);
        expect(bidMatchesOwnStateFilter(market, null)).toBe(true);
        expect(bidMatchesOwnStateFilter(market, POSITION.Winning)).toBe(false);
    });
});
