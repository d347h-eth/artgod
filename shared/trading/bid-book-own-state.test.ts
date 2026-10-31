import { describe, expect, it } from "vitest";
import {
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER as FILTER,
    COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
    COLLECTION_BIDDING_BID_SCOPE_FILTER as SCOPE,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
    TRADING_BIDDING_BID_BOOK_OWN_STATE as STATE,
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION as POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT as CONSTRAINT,
    TRADING_JOB_STATUS as STATUS,
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND as PRICING,
} from "../types/trading.js";
import { ReadModelBadRequestError } from "../read-models/errors.js";
import {
    assertBidScopeSupportsOwnStateFilter,
    bidScopeSupportsOwnStateFilter,
    biddingBidBookOwnStates,
    bidMatchesOwnStateFilter,
    bidMatchesPriceTierFilter,
    countBiddingBidBookOwnFilters,
    filterBiddingBidBookRowsByOwnFilters,
    parseBiddingBidBookPriceTierFilter,
    countBiddingBidBookOwnStates,
    filterBiddingBidBookRowsByOwnState,
    resolveBiddingBidBookOrderPhase,
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
    it.each([PHASE.Queued, PHASE.Replacing])(
        "keeps unconfirmed saved orders distinct from pending verification before %s",
        (verifiedPhase) => {
            expect(
                resolveBiddingBidBookOrderPhase({
                    verified: false,
                    verificationExpected: false,
                    verifiedPhase,
                }),
            ).toBe(PHASE.Unconfirmed);
            expect(
                resolveBiddingBidBookOrderPhase({
                    verified: false,
                    verificationExpected: true,
                    verifiedPhase,
                }),
            ).toBe(PHASE.Verifying);
            expect(
                resolveBiddingBidBookOrderPhase({
                    verified: true,
                    verificationExpected: true,
                    verifiedPhase,
                }),
            ).toBe(verifiedPhase);
        },
    );

    it.each([SCOPE.Token, SCOPE.Traits])(
        "allows own-state selection in %s scope",
        (scope) => {
            expect(bidScopeSupportsOwnStateFilter(scope)).toBe(true);
            expect(() =>
                assertBidScopeSupportsOwnStateFilter(scope),
            ).not.toThrow();
        },
    );

    it("rejects own-state selection in collection scope", () => {
        expect(bidScopeSupportsOwnStateFilter(SCOPE.Collection)).toBe(false);
        expect(() =>
            assertBidScopeSupportsOwnStateFilter(SCOPE.Collection),
        ).toThrow(ReadModelBadRequestError);
    });

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

describe("combined own-state and pricing filters", () => {
    const own = (
        id: string,
        group: string,
        tier: string | null,
        position = POSITION.Losing as
            | typeof POSITION.Losing
            | typeof POSITION.Winning,
    ) => ({
        ...market,
        id,
        group,
        ownJob: { jobId: id, priceTierId: tier },
        ownStatus: { position, constraints: [CONSTRAINT.Ceiling], job: null },
    });
    const losingA = own("losing-a", "a", "tier-a");
    const winningA = own("winning-a", "b", "tier-a", POSITION.Winning);
    const losingB = own("losing-b", "b", "tier-b");
    const manual = own("manual", "c", null);
    const opponent = { ...market, id: "opponent", group: "a", isOwn: false };
    const rows = [opponent, losingA, winningA, losingB, manual];
    const tiers = [
        {
            tierId: "tier-a",
            name: "Base",
            status: STATUS.Enabled,
            sortOrder: 0,
        },
        {
            tierId: "tier-b",
            name: "Old",
            status: STATUS.Archived,
            sortOrder: 1,
        },
    ];
    it("requires both selections on one row and retains only its opponents", () => {
        const filtered = filterBiddingBidBookRowsByOwnFilters(
            rows,
            {
                ownStateFilter: POSITION.Losing,
                priceTierFilter: "tier-a",
            },
            (row) => row.group,
        );
        expect(filtered.map((row) => row.id)).toEqual(["opponent", "losing-a"]);
    });
    it("counts each facet under the other selection and ignores opponents", () => {
        const counts = countBiddingBidBookOwnFilters(
            rows,
            {
                ownStateFilter: POSITION.Losing,
                priceTierFilter: "tier-a",
            },
            tiers,
        );
        expect(counts.ownBidStateCounts.total).toBe(2);
        expect(counts.ownBidStateCounts.states[POSITION.Losing]).toBe(1);
        expect(counts.ownBidStateCounts.states[POSITION.Winning]).toBe(1);
        expect(counts.ownBidStateCounts.states[CONSTRAINT.Ceiling]).toBe(2);
        expect(counts.ownPriceTierCounts.manual).toBe(1);
        expect(
            counts.ownPriceTierCounts.tiers.map((tier) => tier.count),
        ).toEqual([1, 1]);
        const empty = countBiddingBidBookOwnFilters(
            rows,
            { ownStateFilter: POSITION.Draw, priceTierFilter: "tier-b" },
            tiers,
        );
        expect(
            empty.ownPriceTierCounts.tiers.map((tier) => tier.count),
        ).toEqual([0, 0]);
        expect(empty.ownBidStateCounts.states[POSITION.Losing]).toBe(1);
    });
    it("recognizes legacy manual jobs without treating unattributed own orders as manual", () => {
        expect(bidMatchesPriceTierFilter(manual, PRICING.Manual)).toBe(true);
        expect(bidMatchesPriceTierFilter(market, PRICING.Manual)).toBe(false);
        expect(
            bidMatchesPriceTierFilter(
                { ...manual, isOwn: false },
                PRICING.Manual,
            ),
        ).toBe(false);
        expect(
            filterBiddingBidBookRowsByOwnFilters(
                rows,
                { priceTierFilter: PRICING.Manual },
                (row) => row.group,
            ),
        ).toEqual([manual]);
    });
    it("normalizes both transport boundaries and rejects malformed selections", () => {
        expect(parseBiddingBidBookPriceTierFilter(null)).toBeNull();
        expect(parseBiddingBidBookPriceTierFilter(" tier-a ")).toBe("tier-a");
        for (const invalid of [false, 12, {}, "", " ", "x".repeat(129)]) {
            expect(() => parseBiddingBidBookPriceTierFilter(invalid)).toThrow(
                ReadModelBadRequestError,
            );
        }
    });
});
