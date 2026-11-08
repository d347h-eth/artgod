import assert from "node:assert/strict";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE as SOURCE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
    TRADING_BIDDING_BID_SCOPE_KIND as SCOPE,
    TRADING_BIDDING_BID_BOOK_PRICE_KIND as PRICE,
    TRADING_BOT_LIFECYCLE_STATUS as BOT,
    TRADING_JOB_STATUS,
} from "../../../shared/types/trading.ts";
import { buildTokenBiddingBidBookPath } from "../../../shared/http/trading-routes.ts";
import { createOperatorHttp } from "./operator-http.mjs";

export const PASSIVE_BID_BOOK_PROPERTY = Object.freeze({
    Source: "passive-bid-book-indexed-source",
    Market: "passive-bid-book-canonical-cancellation",
    Intent: "passive-bid-book-preserves-declared-intent",
});
export const PASSIVE_BID_BOOK_STAGE = Object.freeze({
    Before: "passive-bid-book-before-maintenance",
    After: "passive-bid-book-after-maintenance",
});

/** Passive backend display only. No bidder process or decision is substituted. */
export async function assertPassiveBidBook({
    origin,
    chainRef,
    collectionRef,
    ledger,
    expectedBidVisible,
    expectedJobId,
    fetchFn = fetch,
}) {
    assert.equal(typeof expectedBidVisible, "boolean");
    assert.ok(
        typeof expectedJobId === "string" && expectedJobId.length > 0,
        "Passive own-intent probe needs the real declared job identity",
    );
    const http = createOperatorHttp({ origin, fetchFn });
    let property = PASSIVE_BID_BOOK_PROPERTY.Source;
    const evidence = { expectedBidVisible };
    try {
        const { bid } = ledger.orders;
        const market = await http.get(
            buildTokenBiddingBidBookPath(chainRef, collectionRef, bid.tokenId),
        );
        const intent = await http.get(
            buildTokenBiddingBidBookPath(chainRef, collectionRef, "1"),
        );
        evidence.market = {
            source: market.bidBook.state.source,
            botStatus: market.bidBook.biddingBotStatus,
            orderIds: market.bidBook.bids.map((row) => row.orderId).slice(0, 8),
        };
        evidence.intent = {
            source: intent.bidBook.state.source,
            botStatus: intent.bidBook.biddingBotStatus,
            jobIds: intent.bidBook.bids
                .flatMap((row) =>
                    row.materialization.jobId
                        ? [row.materialization.jobId]
                        : [],
                )
                .slice(0, 8),
        };
        for (const response of [market, intent]) {
            assert.equal(
                response.bidBook.state.source,
                SOURCE.Orders,
                "No bot snapshot may be inferred from passive indexed rows",
            );
            assert.equal(
                response.bidBook.biddingBotStatus,
                BOT.Inactive,
                "This journey has no running bidder",
            );
        }
        property = PASSIVE_BID_BOOK_PROPERTY.Market;
        assert.equal(market.tokenId, bid.tokenId);
        const rows = market.bidBook.bids.filter(
            (row) => row.orderId === bid.orderHash,
        );
        assert.equal(
            rows.length,
            expectedBidVisible ? 1 : 0,
            "The exact canonical source-cancelled bid must disappear from indexed fallback display",
        );
        if (expectedBidVisible) {
            const row = rows[0];
            assert.equal(row.materialization.kind, MATERIALIZATION.MarketBid);
            assert.equal(row.source, SOURCE.Orders);
            assert.equal(row.scope.kind, SCOPE.Token);
            assert.equal(row.scope.tokenId, bid.tokenId);
            assert.equal(
                row.maker.address.toLowerCase(),
                bid.maker.toLowerCase(),
            );
            assert.equal(row.price.kind, PRICE.Exact);
            assert.equal(
                row.price.wei,
                String(bid.components.offer[0].startAmount),
            );
            assert.equal(
                row.currencyAddress.toLowerCase(),
                ledger.addresses.weth.toLowerCase(),
            );
            assert.equal(row.quantity, "1");
        }
        property = PASSIVE_BID_BOOK_PROPERTY.Intent;
        assert.equal(intent.tokenId, "1");
        const own = intent.bidBook.bids.filter(
            (row) =>
                row.materialization.kind === MATERIALIZATION.OwnJobIntent &&
                row.materialization.jobId === expectedJobId,
        );
        assert.equal(
            own.length,
            1,
            "The separate paused operator declaration must remain visible",
        );
        assert.equal(own[0].materialization.status, TRADING_JOB_STATUS.Paused);
        assert.equal(
            own[0].maker.address,
            null,
            "Declared intent does not invent a market maker identity",
        );
        evidence.passed = true;
        return evidence;
    } catch (error) {
        error.failureProperty = error.failureProperty ?? property;
        error.simulation = { ...error.simulation, passiveBidBook: evidence };
        throw error;
    }
}
