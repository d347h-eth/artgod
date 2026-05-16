import type { FastifyRequest } from "fastify";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";
import { ACTIVITY_FEED_FILTER_KIND } from "@artgod/shared/types";
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
            [ARTGOD_SPAN_ATTRIBUTE.ActivityLimit]: 250,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityLimitPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityCursorPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityKind]:
                ACTIVITY_FEED_FILTER_KIND.Sales,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityExtensionEvent]:
                ARTGOD_TRACE_ATTRIBUTE_VALUE.None,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityExtensionEventPresent]: false,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityTraitsCount]: 2,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityTraitRangesCount]: 1,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityTokenFilterPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityMakerFilterPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityContentHashFilterPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityEventGroupFilterPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityMediaModePresent]: true,
        });
    });

    it("marks extension event feeds separately from grouped kind feeds", () => {
        const attributes = getCollectionActivitySpanAttributes(
            request(
                "/api/ethereum/terraforms/activity?limit=10&kind=sales&extension_event=terraforms:beacon",
            ),
        );

        expect(attributes).toMatchObject({
            [ARTGOD_SPAN_ATTRIBUTE.ActivityKind]:
                ARTGOD_TRACE_ATTRIBUTE_VALUE.None,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityExtensionEvent]:
                "terraforms:beacon",
            [ARTGOD_SPAN_ATTRIBUTE.ActivityExtensionEventPresent]: true,
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
