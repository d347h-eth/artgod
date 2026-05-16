import type { FastifyRequest } from "fastify";
import { PAGINATION_QUERY_PARAMS } from "@artgod/shared/config/pagination";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import {
    ACTIVITY_FEED_FILTER_KIND,
    ACTIVITY_FEED_QUERY_PARAMS,
    TRAIT_FILTER_QUERY_PARAMS,
} from "@artgod/shared/types";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";
import type {
    GetCollectionActivityInput,
    GetCollectionActivityOutput,
} from "../../../application/use-cases/activities/get-collection-activity.js";
import {
    parseActivityFilterKind,
    parseActivityEventGroup,
    parseActivityTokenId,
    getSearchParams,
    parseContentHash,
    parseCursor,
    parseExtensionEventRef,
    parseLimit,
    parseMaker,
    parseMediaMode,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type GetCollectionActivityRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

const ACTIVITY_TRACE_ABSENT = ARTGOD_TRACE_ATTRIBUTE_VALUE.None;
const ACTIVITY_TRACE_INVALID = ARTGOD_TRACE_ATTRIBUTE_VALUE.Invalid;

const ACTIVITY_SPAN_ATTRIBUTE = {
    Limit: ARTGOD_SPAN_ATTRIBUTE.ActivityLimit,
    LimitPresent: ARTGOD_SPAN_ATTRIBUTE.ActivityLimitPresent,
    CursorPresent: ARTGOD_SPAN_ATTRIBUTE.ActivityCursorPresent,
    Kind: ARTGOD_SPAN_ATTRIBUTE.ActivityKind,
    ExtensionEvent: ARTGOD_SPAN_ATTRIBUTE.ActivityExtensionEvent,
    ExtensionEventPresent:
        ARTGOD_SPAN_ATTRIBUTE.ActivityExtensionEventPresent,
    TraitsCount: ARTGOD_SPAN_ATTRIBUTE.ActivityTraitsCount,
    TraitRangesCount: ARTGOD_SPAN_ATTRIBUTE.ActivityTraitRangesCount,
    TokenFilterPresent: ARTGOD_SPAN_ATTRIBUTE.ActivityTokenFilterPresent,
    MakerFilterPresent: ARTGOD_SPAN_ATTRIBUTE.ActivityMakerFilterPresent,
    ContentHashFilterPresent:
        ARTGOD_SPAN_ATTRIBUTE.ActivityContentHashFilterPresent,
    EventGroupFilterPresent:
        ARTGOD_SPAN_ATTRIBUTE.ActivityEventGroupFilterPresent,
    MediaModePresent: ARTGOD_SPAN_ATTRIBUTE.ActivityMediaModePresent,
} as const;

export class GetCollectionActivityHttpAdapter {
    constructor(
        readonly getCollectionActivityPort: {
            getCollectionActivity(
                input: GetCollectionActivityInput,
            ): MaybePromise<GetCollectionActivityOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionActivityRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionActivityPort.getCollectionActivity(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionActivityRoute>,
    ): GetCollectionActivityInput {
        const searchParams = getSearchParams(request);
        const limit = parseLimit(
            searchParams.get(PAGINATION_QUERY_PARAMS.Limit),
        );
        const cursor = parseCursor(
            searchParams.get(PAGINATION_QUERY_PARAMS.Cursor),
        );
        const extensionEvent = parseExtensionEventRef(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.ExtensionEvent),
        );
        const kind = extensionEvent
            ? undefined
            : parseActivityFilterKind(
                  searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.Kind),
              );
        const traits = parseTraits(searchParams);
        const traitRanges = parseTraitRanges(searchParams);
        const mediaMode = parseMediaMode(
            searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
        );
        const tokenId = parseActivityTokenId(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.TokenId),
        );
        const maker = parseMaker(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.Maker),
        );
        const contentHash = parseContentHash(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.ContentHash),
        );
        const eventGroup = parseActivityEventGroup(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.EventGroup),
        );

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            limit,
            cursor: cursor ?? undefined,
            kind,
            traits,
            traitRanges,
            mediaMode,
            tokenId,
            maker,
            contentHash,
            eventGroup,
            extensionEvent,
        };
    }

    private mapOutputToResponse(
        output: GetCollectionActivityOutput,
    ): GetCollectionActivityOutput {
        return output;
    }
}

// Captures low-cardinality request shape so slow activity traces identify the filter path.
export function getCollectionActivitySpanAttributes(
    request: FastifyRequest<GetCollectionActivityRoute>,
): SpanAttributes {
    const searchParams = getSearchParams(request);
    const limit = parseLimitAttribute(
        searchParams.get(PAGINATION_QUERY_PARAMS.Limit),
    );
    const extensionEvent = normalizeExtensionEventAttribute(
        searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.ExtensionEvent),
    );

    return {
        [ACTIVITY_SPAN_ATTRIBUTE.Limit]: limit,
        [ACTIVITY_SPAN_ATTRIBUTE.LimitPresent]: hasQueryValue(
            searchParams,
            PAGINATION_QUERY_PARAMS.Limit,
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.CursorPresent]: hasQueryValue(
            searchParams,
            PAGINATION_QUERY_PARAMS.Cursor,
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.Kind]: extensionEvent
            ? ACTIVITY_TRACE_ABSENT
            : normalizeKindAttribute(
                  searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.Kind),
              ),
        [ACTIVITY_SPAN_ATTRIBUTE.ExtensionEvent]:
            extensionEvent ?? ACTIVITY_TRACE_ABSENT,
        [ACTIVITY_SPAN_ATTRIBUTE.ExtensionEventPresent]:
            Boolean(extensionEvent),
        [ACTIVITY_SPAN_ATTRIBUTE.TraitsCount]: countDelimitedQuerySegments(
            searchParams,
            [TRAIT_FILTER_QUERY_PARAMS.Traits, TRAIT_FILTER_QUERY_PARAMS.Trait],
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.TraitRangesCount]: countDelimitedQuerySegments(
            searchParams,
            [
                TRAIT_FILTER_QUERY_PARAMS.TraitRanges,
                TRAIT_FILTER_QUERY_PARAMS.TraitRange,
            ],
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.TokenFilterPresent]: hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.TokenId,
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.MakerFilterPresent]: hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.Maker,
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.ContentHashFilterPresent]: hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.ContentHash,
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.EventGroupFilterPresent]: hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.EventGroup,
        ),
        [ACTIVITY_SPAN_ATTRIBUTE.MediaModePresent]: hasQueryValue(
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

function normalizeKindAttribute(raw: string | null): string {
    const value = raw?.trim();
    if (!value) return ACTIVITY_TRACE_ABSENT;
    if (
        value === ACTIVITY_FEED_FILTER_KIND.Sales ||
        value === ACTIVITY_FEED_FILTER_KIND.Listings ||
        value === ACTIVITY_FEED_FILTER_KIND.Transfers
    ) {
        return value;
    }
    return ACTIVITY_TRACE_INVALID;
}

function normalizeExtensionEventAttribute(raw: string | null): string | null {
    const value = raw?.trim();
    if (!value) return null;
    const [extensionKey, eventKey, extra] = value.split(":");
    if (extra !== undefined || !extensionKey || !eventKey) {
        return ACTIVITY_TRACE_INVALID;
    }
    return `${extensionKey.toLowerCase()}:${eventKey}`;
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
