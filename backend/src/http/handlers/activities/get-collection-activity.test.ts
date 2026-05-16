import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
    getCollectionActivitySpanAttributes,
    type GetCollectionActivityRoute,
} from "./get-collection-activity.js";

describe("get collection activity span attributes", () => {
    it("summarizes activity request shape without raw filter values", () => {
        const attributes = getCollectionActivitySpanAttributes(
            request(
                "/api/ethereum/terraforms/activity?limit=250&kind=sales&cursor=opaque&traits=Hat:Beanie,Mood:Calm&trait_ranges=Power:3..9&token_id=1&maker=0xabc&content_hash=0xhash&event_group=dream&media_mode=artifact",
            ),
        );

        expect(attributes).toEqual({
            "artgod.activity.limit": 250,
            "artgod.activity.limit_present": true,
            "artgod.activity.cursor_present": true,
            "artgod.activity.kind": "sales",
            "artgod.activity.extension_event": "none",
            "artgod.activity.extension_event_present": false,
            "artgod.activity.traits_count": 2,
            "artgod.activity.trait_ranges_count": 1,
            "artgod.activity.token_filter_present": true,
            "artgod.activity.maker_filter_present": true,
            "artgod.activity.content_hash_filter_present": true,
            "artgod.activity.event_group_filter_present": true,
            "artgod.activity.media_mode_present": true,
        });
    });

    it("marks extension event feeds separately from grouped kind feeds", () => {
        const attributes = getCollectionActivitySpanAttributes(
            request(
                "/api/ethereum/terraforms/activity?limit=10&kind=sales&extension_event=terraforms:beacon",
            ),
        );

        expect(attributes).toMatchObject({
            "artgod.activity.kind": "none",
            "artgod.activity.extension_event": "terraforms:beacon",
            "artgod.activity.extension_event_present": true,
        });
    });
});

function request(url: string): FastifyRequest<GetCollectionActivityRoute> {
    return {
        raw: {
            url,
        },
    } as FastifyRequest<GetCollectionActivityRoute>;
}
