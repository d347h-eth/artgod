import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationWorld } from "../world/world.mjs";
import { buildTokenDetailPath } from "../../../shared/http/collection-routes.ts";
import { buildTokenBiddingBidBookPath } from "../../../shared/http/trading-routes.ts";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../shared/market-data/orders.ts";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE as SOURCE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
    TRADING_BIDDING_BID_SCOPE_KIND as SCOPE,
    TRADING_BIDDING_BID_BOOK_PRICE_KIND as PRICE,
    TRADING_BOT_LIFECYCLE_STATUS as BOT,
} from "../../../shared/types/trading.ts";
import {
    assertHttpProjection,
    HttpProjectionFailure,
    HTTP_PROJECTION_PROPERTY as PROPERTY,
} from "./http-projection.mjs";

function fixture() {
    const { ledger } = createSimulationWorld({ epochSeconds: 1_800_000_000 });
    const branch = "B",
        head = 107;
    const state = ledger.stateAt(branch, head);
    const chain = { publicChainId: ledger.chainId };
    const collection = {
        slug: ledger.collectionSlug,
        address: ledger.addresses.nft,
    };
    const tokens = ["1", "2"].map((tokenId) => ({
        tokenId,
        currentHolder: state.owners.get(tokenId),
        listingPrice: tokenId === "1" ? "1000000000000000000" : null,
        listingCurrency: tokenId === "1" ? ledger.addresses.weth : null,
    }));
    const details = tokens.map((token) => ({
        chain,
        collection,
        token: { ...token },
    }));
    const { bid } = ledger.orders;
    const market = {
        orderId: bid.orderHash,
        source: SOURCE.Orders,
        materialization: { kind: MATERIALIZATION.MarketBid, jobId: null },
        scope: { kind: SCOPE.Token, tokenId: bid.tokenId },
        maker: { address: bid.maker },
        price: { kind: PRICE.Exact, wei: "1000000000000000000" },
        currencyAddress: ledger.addresses.weth,
        quantity: "1",
    };
    const books = ["1", "2"].map((tokenId) => ({
        tokenId,
        bidBook: {
            state: { source: SOURCE.Orders },
            biddingBotStatus: BOT.Inactive,
            bids: tokenId === "2" ? [market] : [],
        },
    }));
    const paths = [];
    const context = {
        origin: "http://127.0.0.1:42722",
        chainRef: "ethereum",
        collectionRef: ledger.collectionSlug,
        ledger,
        branch,
        head,
        snapshot: {
            orders: Object.values(ledger.orders).map((order) => ({
                id: order.orderHash,
                source_status: ORDER_SOURCE_STATUS.Active,
                fillability_status: ORDER_STATUS.Fillable,
            })),
        },
        collectionHttp: { chain, collection, tokens: { items: tokens } },
        fetchFn: async (url, options) => {
            assert.equal(
                options,
                undefined,
                "Projection probes must only read HTTP",
            );
            const route = new URL(url).pathname;
            paths.push(route);
            for (let i = 0; i < 2; i++) {
                const tokenRef = String(i + 1);
                if (
                    route ===
                    buildTokenDetailPath({
                        chainRef: context.chainRef,
                        collectionRef: context.collectionRef,
                        tokenRef,
                    })
                )
                    return Response.json(details[i]);
                if (
                    route ===
                    buildTokenBiddingBidBookPath(
                        context.chainRef,
                        context.collectionRef,
                        tokenRef,
                    )
                )
                    return Response.json(books[i]);
            }
            throw new Error("Unexpected projection route");
        },
    };
    return { context, details, books, tokens, market, paths };
}

test("final HTTP projection checks both canonical holders, collection/detail asks and exact passive market membership", async () => {
    const f = fixture();
    const result = await assertHttpProjection(f.context);
    assert.equal(result.passed, true);
    assert.equal(result.tokens.length, 2);
    assert.deepEqual(
        result.tokens.map((token) => token.market.orderIds),
        [[], [f.market.orderId]],
    );
    assert.equal(f.paths.length, 4);
    assert.equal("freshProof" in result, false);
});

test("the selected A-branch cut exposes its buyer holder and hides actual protocol terminals", async () => {
    const f = fixture();
    f.context.branch = "A";
    f.context.snapshot.orders[0].fillability_status = ORDER_STATUS.Filled;
    f.context.snapshot.orders[1].fillability_status = ORDER_STATUS.Cancelled;
    for (const token of [f.tokens[0], f.details[0].token]) {
        token.currentHolder = f.context.ledger.addresses.buyer;
        token.listingPrice = null;
        token.listingCurrency = null;
    }
    f.books[1].bidBook.bids = [];
    const result = await assertHttpProjection(f.context);
    assert.equal(result.passed, true);
    assert.equal(
        result.tokens[0].currentHolder,
        f.context.ledger.addresses.buyer,
    );
});

test("correct canonical SQL with a stale source-cancelled or terminal HTTP bid fails", async () => {
    for (const change of [
        { source_status: ORDER_SOURCE_STATUS.Cancelled },
        { fillability_status: ORDER_STATUS.Cancelled },
    ]) {
        const f = fixture();
        Object.assign(f.context.snapshot.orders[1], change);
        await assert.rejects(assertHttpProjection(f.context), (error) => {
            assert.ok(error instanceof HttpProjectionFailure);
            assert.equal(error.failureProperty, PROPERTY.BidBook);
            assert.equal(
                error.simulation.httpProjection.expectedBidVisible,
                false,
            );
            return true;
        });
    }
});

test("source-inactive and retained protocol-terminal bids disappear without requiring fresh proof", async () => {
    for (const change of [
        { source_status: ORDER_SOURCE_STATUS.Cancelled },
        { fillability_status: ORDER_STATUS.Cancelled },
        { fillability_status: ORDER_STATUS.Filled },
    ]) {
        const f = fixture();
        Object.assign(f.context.snapshot.orders[1], change);
        f.books[1].bidBook.bids = [];
        assert.equal((await assertHttpProjection(f.context)).passed, true);
    }
});

test("a wrong holder on either token fails despite correct stored state and market rows", async () => {
    for (const index of [0, 1]) {
        const f = fixture();
        f.details[index].token.currentHolder = f.context.ledger.addresses.buyer;
        await assert.rejects(assertHttpProjection(f.context), {
            failureProperty: PROPERTY.Owner,
        });
    }
});

test("missing, wrong-price, wrong-currency or collateral asks fail in detail and collection views", async () => {
    for (const [index, change] of [
        [0, { listingPrice: null }],
        [0, { listingPrice: "999" }],
        [0, { listingCurrency: "0x0000000000000000000000000000000000000000" }],
        [
            1,
            {
                listingPrice: "1000000000000000000",
                listingCurrency: "0x0000000000000000000000000000000000000000",
            },
        ],
    ])
        for (const surface of ["detail", "collection"]) {
            const f = fixture();
            Object.assign(
                surface === "detail" ? f.details[index].token : f.tokens[index],
                change,
            );
            await assert.rejects(assertHttpProjection(f.context), {
                failureProperty: PROPERTY.Ask,
            });
        }
});

test("a filled/source-inactive ask must disappear from both HTTP surfaces", async () => {
    for (const change of [
        { fillability_status: ORDER_STATUS.Filled },
        { source_status: ORDER_SOURCE_STATUS.Cancelled },
    ]) {
        const f = fixture();
        Object.assign(f.context.snapshot.orders[0], change);
        await assert.rejects(assertHttpProjection(f.context), {
            failureProperty: PROPERTY.Ask,
        });
        for (const token of [f.tokens[0], f.details[0].token])
            Object.assign(token, { listingPrice: null, listingCurrency: null });
        assert.equal((await assertHttpProjection(f.context)).passed, true);
    }
});

test("duplicate/extra bid rows and market rows on the wrong token cannot hide in passive fallback", async () => {
    for (const mutate of [
        (f) => f.books[1].bidBook.bids.push(f.market),
        (f) =>
            f.books[1].bidBook.bids.push({
                ...f.market,
                orderId: `0x${"f".repeat(64)}`,
            }),
        (f) => f.books[0].bidBook.bids.push(f.market),
    ]) {
        const f = fixture();
        mutate(f);
        await assert.rejects(assertHttpProjection(f.context), {
            failureProperty: PROPERTY.BidBook,
        });
    }
});

test("separate declared intent may coexist without receiving market or maintenance-intent credit", async () => {
    const f = fixture();
    f.books[0].bidBook.bids.push({
        orderId: "declared-job",
        materialization: {
            kind: MATERIALIZATION.OwnJobIntent,
            jobId: "actual-paused-job",
        },
    });
    const result = await assertHttpProjection(f.context);
    assert.equal(result.passed, true);
    assert.equal("intent" in result, false);
});

test("missing canonical order input and incomplete/misidentified HTTP collection cannot pass", async () => {
    const missing = fixture();
    missing.context.snapshot.orders.pop();
    await assert.rejects(assertHttpProjection(missing.context), {
        failureProperty: PROPERTY.Input,
    });
    for (const mutate of [
        (f) => f.context.collectionHttp.tokens.items.pop(),
        (f) => {
            f.context.collectionHttp.collection = {
                ...f.context.collectionHttp.collection,
                slug: "wrong",
            };
        },
    ]) {
        const f = fixture();
        mutate(f);
        await assert.rejects(assertHttpProjection(f.context), {
            failureProperty: PROPERTY.Collection,
        });
    }
});

test("token detail route uses the shared external encoding contract", () => {
    assert.equal(
        buildTokenDetailPath({
            chainRef: "chain /",
            collectionRef: "collection /",
            tokenRef: "1 /",
        }),
        "/api/chain%20%2F/collection%20%2F/1%20%2F",
    );
});
