import type { FastifyRequest } from "fastify";
import { PAGINATION_QUERY_PARAMS } from "@artgod/shared/config/pagination";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import {
    COLLECTION_DETAIL_QUERY_PARAMS,
    TOKEN_BROWSER_STATUS,
    TRAIT_FILTER_QUERY_PARAMS,
} from "@artgod/shared/types";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
    GetCollectionDetailPort,
} from "../../../application/use-cases/collections/get-collection-detail.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
    parseMediaMode,
    parseMediaPreference,
    parseOwner,
    parseTokenBrowserStatus,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type GetCollectionDetailRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

const COLLECTION_TRACE_VALUE = {
    Listed: TOKEN_BROWSER_STATUS.Listed,
    All: TOKEN_BROWSER_STATUS.All,
    ListedThenUnlisted: TOKEN_BROWSER_STATUS.ListedThenUnlisted,
    Invalid: ARTGOD_TRACE_ATTRIBUTE_VALUE.Invalid,
} as const;

const COLLECTION_SPAN_ATTRIBUTE = {
    Limit: ARTGOD_SPAN_ATTRIBUTE.CollectionLimit,
    LimitPresent: ARTGOD_SPAN_ATTRIBUTE.CollectionLimitPresent,
    CursorPresent: ARTGOD_SPAN_ATTRIBUTE.CollectionCursorPresent,
    TokenStatus: ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus,
    OwnerPresent: ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent,
    TraitFiltersCount: ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount,
    TraitRangesCount: ARTGOD_SPAN_ATTRIBUTE.CollectionTraitRangesCount,
    MediaModePresent: ARTGOD_SPAN_ATTRIBUTE.CollectionMediaModePresent,
} as const;

export class GetCollectionDetailHttpAdapter {
    constructor(readonly getCollectionDetailPort: GetCollectionDetailPort) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionDetailRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionDetailPort.getCollectionDetail(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionDetailRoute>,
    ): GetCollectionDetailInput {
        const searchParams = getSearchParams(request);
        const tokenStatus = parseTokenBrowserStatus(
            searchParams.get(COLLECTION_DETAIL_QUERY_PARAMS.TokenStatus),
        );
        const limit = parseLimit(
            searchParams.get(PAGINATION_QUERY_PARAMS.Limit),
        );
        const cursor = parseCursor(
            searchParams.get(PAGINATION_QUERY_PARAMS.Cursor),
        );
        const owner = parseOwner(
            searchParams.get(COLLECTION_DETAIL_QUERY_PARAMS.Owner),
        );
        const traits = parseTraits(searchParams);
        const traitRanges = parseTraitRanges(searchParams);
        const mediaMode = parseMediaMode(
            searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
        );
        const mediaPreference = parseMediaPreference(
            searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference),
        );

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenStatus,
            limit,
            cursor: cursor ?? undefined,
            traits,
            traitRanges,
            owner,
            mediaMode,
            mediaPreference,
        };
    }

    private mapOutputToResponse(
        output: GetCollectionDetailOutput,
    ): GetCollectionDetailOutput {
        return output;
    }
}

// Captures low-cardinality collection-detail request shape for slow-route traces.
export function getCollectionDetailSpanAttributes(
    request: FastifyRequest<GetCollectionDetailRoute>,
): SpanAttributes {
    const searchParams = getSearchParams(request);
    return {
        [COLLECTION_SPAN_ATTRIBUTE.Limit]: parseLimitAttribute(
            searchParams.get(PAGINATION_QUERY_PARAMS.Limit),
        ),
        [COLLECTION_SPAN_ATTRIBUTE.LimitPresent]: hasQueryValue(
            searchParams,
            PAGINATION_QUERY_PARAMS.Limit,
        ),
        [COLLECTION_SPAN_ATTRIBUTE.CursorPresent]: hasQueryValue(
            searchParams,
            PAGINATION_QUERY_PARAMS.Cursor,
        ),
        [COLLECTION_SPAN_ATTRIBUTE.TokenStatus]: normalizeTokenStatusAttribute(
            searchParams.get(COLLECTION_DETAIL_QUERY_PARAMS.TokenStatus),
        ),
        [COLLECTION_SPAN_ATTRIBUTE.OwnerPresent]: hasQueryValue(
            searchParams,
            COLLECTION_DETAIL_QUERY_PARAMS.Owner,
        ),
        [COLLECTION_SPAN_ATTRIBUTE.TraitFiltersCount]:
            countDelimitedQuerySegments(searchParams, [
                TRAIT_FILTER_QUERY_PARAMS.Traits,
                TRAIT_FILTER_QUERY_PARAMS.Trait,
            ]),
        [COLLECTION_SPAN_ATTRIBUTE.TraitRangesCount]:
            countDelimitedQuerySegments(searchParams, [
                TRAIT_FILTER_QUERY_PARAMS.TraitRanges,
                TRAIT_FILTER_QUERY_PARAMS.TraitRange,
            ]),
        [COLLECTION_SPAN_ATTRIBUTE.MediaModePresent]: hasQueryValue(
            searchParams,
            COLLECTION_MEDIA_QUERY_PARAMS.MediaMode,
        ),
    };
}

function parseLimitAttribute(raw: string | null): number | undefined {
    const value = raw?.trim();
    if (!value || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeTokenStatusAttribute(raw: string | null): string {
    const value = raw?.trim();
    if (!value) return COLLECTION_TRACE_VALUE.Listed;
    return value === COLLECTION_TRACE_VALUE.Listed ||
        value === COLLECTION_TRACE_VALUE.All ||
        value === COLLECTION_TRACE_VALUE.ListedThenUnlisted
        ? value
        : COLLECTION_TRACE_VALUE.Invalid;
}

function countDelimitedQuerySegments(
    searchParams: URLSearchParams,
    keys: string[],
): number {
    let count = 0;
    for (const key of keys) {
        for (const value of searchParams.getAll(key)) {
            count += value
                .split(",")
                .filter((segment) => segment.trim()).length;
        }
    }
    return count;
}

function hasQueryValue(searchParams: URLSearchParams, key: string): boolean {
    return searchParams.getAll(key).some((value) => value.trim().length > 0);
}
