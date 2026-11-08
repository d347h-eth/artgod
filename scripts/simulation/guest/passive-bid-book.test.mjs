import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationWorld } from "../world/world.mjs";
import {
    assertPassiveBidBook,
    PASSIVE_BID_BOOK_PROPERTY,
} from "./passive-bid-book.mjs";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE as SOURCE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND as MATERIALIZATION,
    TRADING_BIDDING_BID_SCOPE_KIND as SCOPE,
    TRADING_BIDDING_BID_BOOK_PRICE_KIND as PRICE,
    TRADING_BOT_LIFECYCLE_STATUS as BOT,
    TRADING_JOB_STATUS,
} from "../../../shared/types/trading.ts";
import { buildTokenBiddingBidBookPath } from "../../../shared/http/trading-routes.ts";

function fixture({
    visible = true,
    source = SOURCE.Orders,
    botStatus = BOT.Inactive,
    includeIntent = true,
    wrongScope = false,
} = {}) {
    const { ledger } = createSimulationWorld({ epochSeconds: 1_800_000_000 });
    const bid = ledger.orders.bid;
    const paths = [];
    const market = {
        orderId: bid.orderHash,
        source: SOURCE.Orders,
        materialization: { kind: MATERIALIZATION.MarketBid, jobId: null },
        scope: { kind: SCOPE.Token, tokenId: wrongScope ? "1" : bid.tokenId },
        maker: { address: bid.maker },
        price: {
            kind: PRICE.Exact,
            wei: String(bid.components.offer[0].startAmount),
        },
        currencyAddress: ledger.addresses.weth,
        quantity: "1",
    };
    const own = {
        orderId: "declared-job",
        materialization: {
            kind: MATERIALIZATION.OwnJobIntent,
            jobId: "actual-job",
            status: TRADING_JOB_STATUS.Paused,
        },
        maker: { address: null },
    };
    return {
        paths,
        context: {
            origin: "http://127.0.0.1:42722",
            chainRef: "ethereum",
            collectionRef: ledger.collectionSlug,
            ledger,
            expectedJobId: "actual-job",
            expectedBidVisible: true,
            fetchFn: async (url, options) => {
                assert.equal(
                    options,
                    undefined,
                    "The passive probe must issue reads only",
                );
                paths.push(new URL(url).pathname);
                const tokenId = url.includes("/2/bidding/") ? "2" : "1";
                return Response.json({
                    tokenId,
                    bidBook: {
                        state: { source },
                        biddingBotStatus: botStatus,
                        bids:
                            tokenId === "2"
                                ? visible
                                    ? [market]
                                    : []
                                : includeIntent
                                  ? [own]
                                  : [],
                    },
                });
            },
        },
    };
}

test("passive HTTP probes verify the exact indexed bid and separately declared paused intent", async () => {
    const f = fixture();
    const result = await assertPassiveBidBook(f.context);
    assert.equal(result.passed, true);
    assert.equal(result.market.source, SOURCE.Orders);
    assert.deepEqual(result.intent.jobIds, ["actual-job"]);
    assert.deepEqual(f.paths, [
        `/api/ethereum/${f.context.collectionRef}/2/bidding/bids`,
        `/api/ethereum/${f.context.collectionRef}/1/bidding/bids`,
    ]);
    const cancelled = fixture({ visible: false });
    assert.equal(
        (
            await assertPassiveBidBook({
                ...cancelled.context,
                expectedBidVisible: false,
            })
        ).passed,
        true,
    );
});

test("bot snapshots or a running bot cannot qualify the passive source scenario", async () => {
    for (const options of [
        { source: SOURCE.BotSnapshot },
        { botStatus: BOT.Active },
    ])
        await assert.rejects(
            assertPassiveBidBook(fixture(options).context),
            (error) => {
                assert.equal(
                    error.failureProperty,
                    PASSIVE_BID_BOOK_PROPERTY.Source,
                );
                return true;
            },
        );
});

test("empty views, stale cancelled rows and wrong scope cannot satisfy the exact market invariant", async () => {
    for (const [options, visible] of [
        [{ visible: false }, true],
        [{ visible: true }, false],
        [{ wrongScope: true }, true],
    ])
        await assert.rejects(
            assertPassiveBidBook({
                ...fixture(options).context,
                expectedBidVisible: visible,
            }),
            (error) => {
                assert.equal(
                    error.failureProperty,
                    PASSIVE_BID_BOOK_PROPERTY.Market,
                );
                return true;
            },
        );
});

test("removing the unrelated paused declaration fails even after market cancellation succeeds", async () => {
    await assert.rejects(
        assertPassiveBidBook({
            ...fixture({ visible: false, includeIntent: false }).context,
            expectedBidVisible: false,
        }),
        (error) => {
            assert.equal(
                error.failureProperty,
                PASSIVE_BID_BOOK_PROPERTY.Intent,
            );
            assert.equal(
                error.simulation.passiveBidBook.market.orderIds.length,
                0,
            );
            return true;
        },
    );
});

test("token bid-book route consumes the shared external path contract", () => {
    assert.equal(
        buildTokenBiddingBidBookPath("chain /", "collection /", "1 /"),
        "/api/chain%20%2F/collection%20%2F/1%20%2F/bidding/bids",
    );
});
