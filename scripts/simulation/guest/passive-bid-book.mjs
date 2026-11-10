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

function assertPassiveSource(response) {
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

/** Market projection only; this earns no operator-intent or trading authority. */
export async function assertPassiveMarketBidBook({
    origin,
    chainRef,
    collectionRef,
    ledger,
    tokenRef = ledger.orders.bid.tokenId,
    expectedBidVisible,
    fetchFn = fetch,
}) {
    assert.equal(typeof expectedBidVisible, "boolean");
    const evidence = { tokenId: tokenRef, expectedBidVisible };
    let property = PASSIVE_BID_BOOK_PROPERTY.Source;
    try {
        const { bid } = ledger.orders;
        const market = await createOperatorHttp({ origin, fetchFn }).get(
            buildTokenBiddingBidBookPath(chainRef, collectionRef, tokenRef),
        );
        evidence.source = String(market.bidBook.state.source).slice(0, 128);
        evidence.botStatus = String(market.bidBook.biddingBotStatus).slice(
            0,
            128,
        );
        evidence.observedOrderIds = market.bidBook.bids
            .map((row) => String(row.orderId).slice(0, 128))
            .slice(0, 8);
        assertPassiveSource(market);
        property = PASSIVE_BID_BOOK_PROPERTY.Market;
        assert.equal(market.tokenId, tokenRef);
        for (const row of market.bidBook.bids) {
            assert.ok(
                Object.values(MATERIALIZATION).includes(
                    row.materialization.kind,
                ),
                "Every passive row needs an explicit market or declared-intent identity",
            );
            if (row.materialization.kind === MATERIALIZATION.OwnJobIntent) {
                assert.ok(
                    typeof row.materialization.jobId === "string" &&
                        row.materialization.jobId.length > 0 &&
                        row.orderId !== bid.orderHash,
                    "Declared intent cannot disguise the canonical market bid",
                );
            }
        }
        const rows = market.bidBook.bids.filter(
            (row) => row.materialization.kind === MATERIALIZATION.MarketBid,
        );
        evidence.orderIds = rows
            .map((row) => String(row.orderId).slice(0, 128))
            .slice(0, 8);
        evidence.marketRowCount = rows.length;
        assert.equal(
            rows.length,
            expectedBidVisible ? 1 : 0,
            "Indexed fallback must contain exactly the expected market bids",
        );
        if (expectedBidVisible) {
            assert.equal(tokenRef, bid.tokenId);
            const row = rows[0];
            assert.equal(row.orderId, bid.orderHash);
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
        evidence.passed = true;
        return evidence;
    } catch (error) {
        error.failureProperty = error.failureProperty ?? property;
        error.simulation = {
            ...error.simulation,
            passiveMarketBidBook: evidence,
        };
        throw error;
    }
}

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
        evidence.market = await assertPassiveMarketBidBook({
            origin,
            chainRef,
            collectionRef,
            ledger,
            expectedBidVisible,
            fetchFn,
        });
        const intent = await http.get(
            buildTokenBiddingBidBookPath(chainRef, collectionRef, "1"),
        );
        evidence.intent = {
            source: intent.bidBook.state.source,
            botStatus: intent.bidBook.biddingBotStatus,
            jobIds: intent.bidBook.bids
                .flatMap((row) =>
                    row.materialization.jobId
                        ? [String(row.materialization.jobId).slice(0, 128)]
                        : [],
                )
                .slice(0, 8),
        };
        assertPassiveSource(intent);
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
