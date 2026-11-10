import assert from "node:assert/strict";
import { buildTokenDetailPath } from "../../../shared/http/collection-routes.ts";
import {
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
} from "../../../shared/market-data/orders.ts";
import { createOperatorHttp } from "./operator-http.mjs";
import { assertPassiveMarketBidBook } from "./passive-bid-book.mjs";

export const HTTP_PROJECTION_PROPERTY = Object.freeze({
    Input: "http-projection-validated-input",
    Collection: "http-projection-collection-token-membership",
    Owner: "http-projection-canonical-token-holder",
    Ask: "http-projection-current-ask",
    BidBook: "http-projection-passive-market-membership",
});

export class HttpProjectionFailure extends Error {
    constructor(property, evidence, cause) {
        super(
            `${property}: ${String(cause?.message ?? cause).slice(0, 2048)}`,
            { cause },
        );
        this.name = "HttpProjectionFailure";
        this.failureProperty = property;
        this.simulation = { ...cause?.simulation, httpProjection: evidence };
    }
}

const bounded = (value) =>
    value === null ? null : String(value).slice(0, 128);
const summary = (token) => ({
    tokenId: bounded(token.tokenId),
    currentHolder: bounded(token.currentHolder),
    listingPrice: bounded(token.listingPrice),
    listingCurrency: bounded(token.listingCurrency),
});

function visibleOrder(snapshot, orderId) {
    const rows = snapshot.orders.filter((row) => row.id === orderId);
    assert.equal(
        rows.length,
        1,
        "The validated snapshot must retain each fixture order exactly once",
    );
    const row = rows[0];
    assert.ok(Object.values(ORDER_SOURCE_STATUS).includes(row.source_status));
    assert.ok(Object.values(ORDER_STATUS).includes(row.fillability_status));
    // This is the public projection contract, not a new proof-reuse/freshness
    // policy. The caller has already checked canonical order correctness.
    return (
        row.source_status === ORDER_SOURCE_STATUS.Active &&
        row.fillability_status === ORDER_STATUS.Fillable
    );
}

function assertIdentity(response, ledger) {
    assert.equal(response.chain.publicChainId, ledger.chainId);
    assert.equal(response.collection.slug, ledger.collectionSlug);
    assert.equal(
        response.collection.address.toLowerCase(),
        ledger.addresses.nft.toLowerCase(),
    );
}

function assertAsk(token, expected) {
    assert.equal(token.listingPrice, expected?.price ?? null);
    assert.equal(
        token.listingCurrency?.toLowerCase() ?? token.listingCurrency,
        expected?.currency ?? null,
    );
}

/** Final passive HTTP projection of an independently checked fixed chain cut.
 * Terminal/source-inactive orders stay hidden without earning fresh proof credit.
 */
export async function assertHttpProjection({
    origin,
    chainRef,
    collectionRef,
    ledger,
    branch,
    head,
    snapshot,
    collectionHttp,
    fetchFn = fetch,
}) {
    let property = HTTP_PROJECTION_PROPERTY.Input;
    const evidence = { branch, head, tokens: [], passed: false };
    try {
        const state = ledger.stateAt(branch, head);
        const tokenIds = [...state.owners.keys()].sort();
        assert.equal(
            tokenIds.length,
            2,
            "This fixture must expose both canonical ERC721 tokens",
        );
        const askVisible = visibleOrder(
            snapshot,
            ledger.orders.listing.orderHash,
        );
        const bidVisible = visibleOrder(snapshot, ledger.orders.bid.orderHash);
        evidence.expectedAskVisible = askVisible;
        evidence.expectedBidVisible = bidVisible;
        const expectedAsk = askVisible
            ? {
                  price: String(
                      ledger.orders.listing.components.consideration[0]
                          .startAmount,
                  ),
                  currency:
                      ledger.orders.listing.components.consideration[0].token.toLowerCase(),
              }
            : null;
        const http = createOperatorHttp({ origin, fetchFn });
        property = HTTP_PROJECTION_PROPERTY.Collection;
        assertIdentity(collectionHttp, ledger);
        assert.deepEqual(
            collectionHttp.tokens.items.map((token) => token.tokenId).sort(),
            tokenIds,
            "The complete two-token collection view must contain both tokens exactly once",
        );
        for (const tokenId of tokenIds) {
            const card = collectionHttp.tokens.items.find(
                (token) => token.tokenId === tokenId,
            );
            property = HTTP_PROJECTION_PROPERTY.Owner;
            const detail = await http.get(
                buildTokenDetailPath({
                    chainRef,
                    collectionRef,
                    tokenRef: tokenId,
                }),
            );
            assertIdentity(detail, ledger);
            evidence.tokens.push({
                ...summary(detail.token),
                collectionAsk: {
                    listingPrice: bounded(card.listingPrice),
                    listingCurrency: bounded(card.listingCurrency),
                },
            });
            assert.equal(detail.token.tokenId, tokenId);
            assert.equal(
                detail.token.currentHolder?.toLowerCase(),
                state.owners.get(tokenId),
            );
            property = HTTP_PROJECTION_PROPERTY.Ask;
            const ask =
                tokenId === ledger.orders.listing.tokenId ? expectedAsk : null;
            assertAsk(detail.token, ask);
            assertAsk(card, ask);
            property = HTTP_PROJECTION_PROPERTY.BidBook;
            evidence.tokens.at(-1).market = await assertPassiveMarketBidBook({
                origin,
                chainRef,
                collectionRef,
                ledger,
                tokenRef: tokenId,
                expectedBidVisible:
                    bidVisible && tokenId === ledger.orders.bid.tokenId,
                fetchFn,
            });
        }
        evidence.passed = true;
        return evidence;
    } catch (cause) {
        throw new HttpProjectionFailure(property, evidence, cause);
    }
}
