import type { FastifyRequest } from "fastify";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import {
    ACTIVITY_FEED_FILTER_KIND,
    ACTIVITY_FEED_QUERY_PARAMS,
} from "@artgod/shared/types";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
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

const ACTIVITY_TRACE_ABSENT = "none";

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
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
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
    const limit = parseLimitAttribute(searchParams.get("limit"));
    const extensionEvent = normalizeExtensionEventAttribute(
        searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.ExtensionEvent),
    );

    return {
        "artgod.activity.limit": limit,
        "artgod.activity.limit_present": hasQueryValue(searchParams, "limit"),
        "artgod.activity.cursor_present": hasQueryValue(searchParams, "cursor"),
        "artgod.activity.kind": extensionEvent
            ? ACTIVITY_TRACE_ABSENT
            : normalizeKindAttribute(
                  searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.Kind),
              ),
        "artgod.activity.extension_event":
            extensionEvent ?? ACTIVITY_TRACE_ABSENT,
        "artgod.activity.extension_event_present": Boolean(extensionEvent),
        "artgod.activity.traits_count": countDelimitedQuerySegments(
            searchParams,
            ["traits", "trait"],
        ),
        "artgod.activity.trait_ranges_count": countDelimitedQuerySegments(
            searchParams,
            ["trait_ranges", "trait_range"],
        ),
        "artgod.activity.token_filter_present": hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.TokenId,
        ),
        "artgod.activity.maker_filter_present": hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.Maker,
        ),
        "artgod.activity.content_hash_filter_present": hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.ContentHash,
        ),
        "artgod.activity.event_group_filter_present": hasQueryValue(
            searchParams,
            ACTIVITY_FEED_QUERY_PARAMS.EventGroup,
        ),
        "artgod.activity.media_mode_present": hasQueryValue(
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
    return "invalid";
}

function normalizeExtensionEventAttribute(raw: string | null): string | null {
    const value = raw?.trim();
    if (!value) return null;
    const [extensionKey, eventKey, extra] = value.split(":");
    if (extra !== undefined || !extensionKey || !eventKey) return "invalid";
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
