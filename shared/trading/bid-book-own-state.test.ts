import { describe, expect, it } from "vitest";
import {
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER as FILTER,
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
    TRADING_BIDDING_BID_BOOK_OWN_STATE as STATE,
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION as POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT as CONSTRAINT,
    TRADING_JOB_STATUS as STATUS,
} from "../types/trading.js";
import {
    biddingBidBookOwnStates,
    bidMatchesOwnStateFilter,
    countBiddingBidBookOwnStates,
    filterBiddingBidBookRowsByOwnState,
    type BiddingBidBookOwnStateSignals,
} from "./bid-book-own-state.js";

const market: BiddingBidBookOwnStateSignals = {
    isOwn: true,
    materialization: {
        kind: MATERIALIZATION.MarketBid,
        phase: null,
        status: null,
    },
    ownStatus: null,
};

describe("own bid-book states", () => {
    it("uses authoritative decisions, deduplicates constraints and supersedes intent phases", () => {
        const bid: BiddingBidBookOwnStateSignals = {
            ...market,
            materialization: {
                kind: MATERIALIZATION.OwnJobIntent,
                phase: PHASE.Verifying,
                status: STATUS.Enabled,
            },
            ownStatus: {
                position: POSITION.Losing,
                constraints: [CONSTRAINT.Ceiling, CONSTRAINT.Ceiling],
                job: null,
            },
        };
        expect(biddingBidBookOwnStates(bid)).toEqual([
            POSITION.Losing,
            CONSTRAINT.Ceiling,
        ]);
        expect(bidMatchesOwnStateFilter(bid, PHASE.Verifying)).toBe(false);
        expect(biddingBidBookOwnStates({ ...bid, isOwn: false })).toEqual([]);
    });

    it.each([
        PHASE.Canceling,
        PHASE.CancelFailed,
        PHASE.Cancelled,
        PHASE.Replacing,
    ])("matches declared pause independently of %s", (phase) => {
        const bid: BiddingBidBookOwnStateSignals = {
            ...market,
            materialization: {
                kind: MATERIALIZATION.OwnJobIntent,
                phase,
                status: STATUS.Paused,
            },
        };
        expect(biddingBidBookOwnStates(bid)).toEqual([PHASE.Paused, phase]);
        expect(bidMatchesOwnStateFilter(bid, PHASE.Paused)).toBe(true);
        expect(bidMatchesOwnStateFilter(bid, FILTER.Active)).toBe(false);
        expect(bidMatchesOwnStateFilter(bid, phase)).toBe(true);
        expect(
            bidMatchesOwnStateFilter(
                {
                    ...bid,
                    materialization: {
                        ...bid.materialization,
                        status: STATUS.Archived,
                    },
                },
                PHASE.Paused,
            ),
        ).toBe(false);
    });

    it("preserves pause alongside bot position and constraints on market rows", () => {
        const bid: BiddingBidBookOwnStateSignals = {
            ...market,
            ownStatus: {
                position: POSITION.Losing,
                constraints: [CONSTRAINT.Ceiling],
                job: { status: STATUS.Paused },
            },
        };
        expect(biddingBidBookOwnStates(bid)).toEqual([
            PHASE.Paused,
            POSITION.Losing,
            CONSTRAINT.Ceiling,
        ]);
        expect(bidMatchesOwnStateFilter(bid, FILTER.Active)).toBe(false);
    });

    it("classifies missing market evidence as unknown without guessing competitiveness", () => {
        expect(biddingBidBookOwnStates(market)).toEqual([STATE.Unknown]);
        expect(bidMatchesOwnStateFilter(market, STATE.Unknown)).toBe(true);
        expect(bidMatchesOwnStateFilter(market, FILTER.Active)).toBe(true);
        expect(bidMatchesOwnStateFilter(market, POSITION.Winning)).toBe(false);
    });

    it("covers every own row and partitions active from paused for every lifecycle and job status", () => {
        const ownRows: BiddingBidBookOwnStateSignals[] = [
            ...Object.values(PHASE).flatMap((phase) =>
                Object.values(STATUS).map((status) => ({
                    ...market,
                    materialization: {
                        kind: MATERIALIZATION.OwnJobIntent,
                        phase,
                        status,
                    },
                })),
            ),
            ...Object.values(POSITION).map((position) => ({
                ...market,
                ownStatus: {
                    position,
                    constraints: [
                        CONSTRAINT.Floor,
                        CONSTRAINT.Ceiling,
                        CONSTRAINT.Floor,
                    ],
                    job: { status: STATUS.Enabled },
                },
            })),
            market,
        ];
        const rows = [
            ...ownRows,
            ...ownRows.map((row) => ({ ...row, isOwn: false })),
        ];
        const counts = countBiddingBidBookOwnStates(rows.values());
        const matchedRows = new Set<BiddingBidBookOwnStateSignals>();
        expect(counts.total).toBe(ownRows.length);
        for (const state of COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS) {
            const matches = rows.filter((row) =>
                bidMatchesOwnStateFilter(row, state),
            );
            expect(counts.states[state]).toBe(matches.length);
            matches.forEach((row) => matchedRows.add(row));
        }
        expect(matchedRows).toEqual(new Set(ownRows));
        const activeRows = rows.filter((row) =>
            bidMatchesOwnStateFilter(row, FILTER.Active),
        );
        const pausedRows = rows.filter((row) =>
            bidMatchesOwnStateFilter(row, PHASE.Paused),
        );
        expect(activeRows.every((row) => !pausedRows.includes(row))).toBe(true);
        expect(new Set([...activeRows, ...pausedRows])).toEqual(
            new Set(ownRows),
        );
        expect(counts.states[FILTER.Active] + counts.states[PHASE.Paused]).toBe(
            counts.total,
        );
        expect(
            Object.values(counts.states).reduce((sum, count) => sum + count, 0),
        ).toBeGreaterThan(counts.total);
    });
});

describe("own-state selection with opponent context", () => {
    const own = (
        group: string,
        position: typeof POSITION.Losing | typeof POSITION.Winning,
    ) => ({
        ...market,
        group,
        ownStatus: { position, constraints: [], job: null },
    });
    const opponent = (group: string) => ({ ...market, group, isOwn: false });
    const losing = own("matched", POSITION.Losing);
    const relatedOpponent = opponent("matched");
    const otherOwn = own("matched", POSITION.Winning);
    const winning = own("other", POSITION.Winning);
    const unrelatedOpponent = opponent("other");
    const opponentOnly = opponent("opponent-only");
    const rows = [
        relatedOpponent,
        losing,
        otherOwn,
        winning,
        unrelatedOpponent,
        opponentOnly,
    ];
    const key = (row: (typeof rows)[number]) => row.group;

    it("keeps matching own rows and only opponents in their groups, in original order", () => {
        expect(
            filterBiddingBidBookRowsByOwnState(rows, POSITION.Losing, key),
        ).toEqual([relatedOpponent, losing]);
        expect(biddingBidBookOwnStates(relatedOpponent)).toEqual([]);
        expect(countBiddingBidBookOwnStates(rows).states[POSITION.Losing]).toBe(
            1,
        );
    });

    it("respects an independently applied ownership filter", () => {
        expect(
            filterBiddingBidBookRowsByOwnState(
                rows.filter((row) => row.isOwn),
                POSITION.Losing,
                key,
            ),
        ).toEqual([losing]);
    });

    it("keeps results empty without matching own rows even when opponents remain", () => {
        expect(
            filterBiddingBidBookRowsByOwnState(rows, POSITION.Draw, key),
        ).toEqual([]);
        expect(
            filterBiddingBidBookRowsByOwnState(
                [relatedOpponent, opponentOnly],
                POSITION.Losing,
                key,
            ),
        ).toEqual([]);
    });

    it("keeps opponent context only in groups with active own rows", () => {
        const paused = {
            ...losing,
            ownStatus: {
                ...losing.ownStatus,
                job: { status: STATUS.Paused },
            },
        };
        const pausedOnly = { ...paused, group: "paused-only" };
        const pausedOpponent = opponent("paused-only");
        const mixedRows = [...rows, paused, pausedOnly, pausedOpponent];
        expect(
            filterBiddingBidBookRowsByOwnState(mixedRows, FILTER.Active, key),
        ).toEqual([
            relatedOpponent,
            losing,
            otherOwn,
            winning,
            unrelatedOpponent,
        ]);
        expect(
            filterBiddingBidBookRowsByOwnState(
                [pausedOnly, pausedOpponent, opponentOnly],
                FILTER.Active,
                key,
            ),
        ).toEqual([]);
    });

    it("clears only state selection when the filter is cleared", () => {
        expect(filterBiddingBidBookRowsByOwnState(rows, null, key)).toEqual(
            rows,
        );
    });
});
