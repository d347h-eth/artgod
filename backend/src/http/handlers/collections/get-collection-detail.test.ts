import type { FastifyRequest } from "fastify";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";
import { TOKEN_BROWSER_STATUS } from "@artgod/shared/types";
import {
    COLLECTION_MEDIA_MODES,
    COLLECTION_MEDIA_QUERY_PARAMS,
} from "@artgod/shared/extensions";
import { describe, expect, it } from "vitest";
import {
    getCollectionDetailSpanAttributes,
    type GetCollectionDetailRoute,
} from "./get-collection-detail.js";

describe("get collection detail span attributes", () => {
    it("summarizes collection request shape without raw filter values", () => {
        const attributes = getCollectionDetailSpanAttributes(
            request(
                `/api/ethereum/terraforms?limit=250&token_status=all&cursor=opaque&owner=0xabc&traits=Hat:Beanie,Mood:Calm&trait_ranges=Power:3..9&${COLLECTION_MEDIA_QUERY_PARAMS.MediaMode}=${COLLECTION_MEDIA_MODES.Snapshot}`,
            ),
        );

        expect(attributes).toEqual({
            [ARTGOD_SPAN_ATTRIBUTE.CollectionLimit]: 250,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionLimitPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionCursorPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus]:
                TOKEN_BROWSER_STATUS.All,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]: true,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]: 2,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitRangesCount]: 1,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionMediaModePresent]: true,
        });
    });

    it("uses default and invalid labels for absent or invalid option values", () => {
        const attributes = getCollectionDetailSpanAttributes(
            request("/api/ethereum/terraforms?token_status=raw"),
        );

        expect(attributes).toMatchObject({
            [ARTGOD_SPAN_ATTRIBUTE.CollectionLimit]: undefined,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionLimitPresent]: false,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus]:
                ARTGOD_TRACE_ATTRIBUTE_VALUE.Invalid,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionMediaModePresent]: false,
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
