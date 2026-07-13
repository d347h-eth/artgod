import type { FastifyRequest } from "fastify";
import {
    COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
    COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "@artgod/shared/types";
import { describe, expect, it } from "vitest";
import {
    COLLECTION_MEDIA_MODES,
    COLLECTION_MEDIA_QUERY_PARAMS,
} from "@artgod/shared/extensions";
import {
    BIDDING_SPAN_ATTRIBUTE,
    TRACE_ATTRIBUTE_VALUE,
} from "../../../application/use-cases/trading/bidding-observability.js";
import {
    getCollectionBiddingBidBookSpanAttributes,
    ListCollectionBiddingBidBookHttpAdapter,
    type ListCollectionBiddingBidBookRoute,
} from "./list-collection-bidding-bid-book.js";

describe("get collection bidding bid-book span attributes", () => {
    it("summarizes bidding request shape without raw filter values", () => {
        const attributes = getCollectionBiddingBidBookSpanAttributes(
            request(
                `/api/ethereum/terraforms/bidding/bids?bid_scope=traits&trait_join=and&limit=50&cursor=opaque&maker=0xabc&traits=Hat:Beanie,Mood:Calm&trait_ranges=Power:3..9&${COLLECTION_MEDIA_QUERY_PARAMS.MediaMode}=${COLLECTION_MEDIA_MODES.Snapshot}`,
            ),
        );

        expect(attributes).toEqual({
            [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]:
                COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
            [BIDDING_SPAN_ATTRIBUTE.TraitJoin]:
                COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
            [BIDDING_SPAN_ATTRIBUTE.Limit]: 50,
            [BIDDING_SPAN_ATTRIBUTE.LimitPresent]: true,
            [BIDDING_SPAN_ATTRIBUTE.CursorPresent]: true,
            [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]: true,
            [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]: 2,
            [BIDDING_SPAN_ATTRIBUTE.TraitRangesCount]: 1,
            [BIDDING_SPAN_ATTRIBUTE.MediaModePresent]: true,
        });
    });

    it("uses defaults and invalid labels for absent or invalid option values", () => {
        const attributes = getCollectionBiddingBidBookSpanAttributes(
            request(
                "/api/ethereum/terraforms/bidding/bids?bid_scope=bad&trait_join=xor&limit=nan",
            ),
        );

        expect(attributes).toMatchObject({
            [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]: TRACE_ATTRIBUTE_VALUE.Invalid,
            [BIDDING_SPAN_ATTRIBUTE.TraitJoin]: TRACE_ATTRIBUTE_VALUE.Invalid,
            [BIDDING_SPAN_ATTRIBUTE.Limit]: undefined,
            [BIDDING_SPAN_ATTRIBUTE.LimitPresent]: true,
            [BIDDING_SPAN_ATTRIBUTE.CursorPresent]: false,
            [BIDDING_SPAN_ATTRIBUTE.MediaModePresent]: false,
        });
    });
});

describe("ListCollectionBiddingBidBookHttpAdapter", () => {
    it("maps the private own-bid filter into the use-case input", async () => {
        let captured: unknown;
        const adapter = new ListCollectionBiddingBidBookHttpAdapter(
            {
                listCollectionBiddingBidBook: (input) => {
                    captured = input;
                    return input as never;
                },
            },
            true,
        );

        await adapter.handle(
            routeRequest(
                `/api/ethereum/terraforms/bidding/bids?${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}`,
            ),
        );

        expect(captured).toEqual(
            expect.objectContaining({
                includeOwnJobContext: true,
                ownershipFilter:
                    COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
            }),
        );
    });

    it("rejects unknown ownership filter values", async () => {
        const adapter = new ListCollectionBiddingBidBookHttpAdapter(
            {
                listCollectionBiddingBidBook: (input) => input as never,
            },
            true,
        );

        await expect(
            adapter.handle(
                routeRequest(
                    `/api/ethereum/terraforms/bidding/bids?${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership}=unknown`,
                ),
            ),
        ).rejects.toThrow("Invalid bid ownership filter");
    });
});

function request(
    url: string,
): FastifyRequest<ListCollectionBiddingBidBookRoute> {
    return {
        raw: {
            url,
        },
    } as FastifyRequest<ListCollectionBiddingBidBookRoute>;
}

function routeRequest(
    url: string,
): FastifyRequest<ListCollectionBiddingBidBookRoute> {
    return {
        raw: { url },
        params: {
            chain_ref: "ethereum",
            collection_ref: "terraforms",
        },
    } as FastifyRequest<ListCollectionBiddingBidBookRoute>;
}
