import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
    getCollectionDetailSpanAttributes,
    type GetCollectionDetailRoute,
} from "./get-collection-detail.js";

describe("get collection detail span attributes", () => {
    it("summarizes collection request shape without raw filter values", () => {
        const attributes = getCollectionDetailSpanAttributes(
            request(
                "/api/ethereum/terraforms?limit=250&token_status=all&cursor=opaque&owner=0xabc&traits=Hat:Beanie,Mood:Calm&trait_ranges=Power:3..9&media_mode=artifact",
            ),
        );

        expect(attributes).toEqual({
            "artgod.collection.limit": 250,
            "artgod.collection.limit_present": true,
            "artgod.collection.cursor_present": true,
            "artgod.collection.token_status": "all",
            "artgod.collection.owner_present": true,
            "artgod.collection.trait_filters_count": 2,
            "artgod.collection.trait_ranges_count": 1,
            "artgod.collection.media_mode_present": true,
        });
    });

    it("uses default and invalid labels for absent or invalid option values", () => {
        const attributes = getCollectionDetailSpanAttributes(
            request("/api/ethereum/terraforms?token_status=raw"),
        );

        expect(attributes).toMatchObject({
            "artgod.collection.limit": undefined,
            "artgod.collection.limit_present": false,
            "artgod.collection.token_status": "invalid",
            "artgod.collection.media_mode_present": false,
        });
    });
});

function request(url: string): FastifyRequest<GetCollectionDetailRoute> {
    return {
        raw: {
            url,
        },
    } as FastifyRequest<GetCollectionDetailRoute>;
}
