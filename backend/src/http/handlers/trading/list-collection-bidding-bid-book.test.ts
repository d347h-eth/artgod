import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
    getCollectionBiddingBidBookSpanAttributes,
    type ListCollectionBiddingBidBookRoute,
} from "./list-collection-bidding-bid-book.js";

describe("get collection bidding bid-book span attributes", () => {
    it("summarizes bidding request shape without raw filter values", () => {
        const attributes = getCollectionBiddingBidBookSpanAttributes(
            request(
                "/api/ethereum/terraforms/bidding/bids?bid_scope=traits&trait_join=and&limit=50&cursor=opaque&maker=0xabc&traits=Hat:Beanie,Mood:Calm&trait_ranges=Power:3..9&media_mode=artifact",
            ),
        );

        expect(attributes).toEqual({
            "artgod.bidding.scope_filter": "traits",
            "artgod.bidding.trait_join": "and",
            "artgod.bidding.limit": 50,
            "artgod.bidding.limit_present": true,
            "artgod.bidding.cursor_present": true,
            "artgod.bidding.maker_filter_present": true,
            "artgod.bidding.trait_filters_count": 2,
            "artgod.bidding.trait_ranges_count": 1,
            "artgod.bidding.media_mode_present": true,
        });
    });

    it("uses defaults and invalid labels for absent or invalid option values", () => {
        const attributes = getCollectionBiddingBidBookSpanAttributes(
            request(
                "/api/ethereum/terraforms/bidding/bids?bid_scope=bad&trait_join=xor&limit=nan",
            ),
        );

        expect(attributes).toMatchObject({
            "artgod.bidding.scope_filter": "invalid",
            "artgod.bidding.trait_join": "invalid",
            "artgod.bidding.limit": undefined,
            "artgod.bidding.limit_present": true,
            "artgod.bidding.cursor_present": false,
            "artgod.bidding.media_mode_present": false,
        });
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
