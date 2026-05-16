import type { FastifyRequest } from "fastify";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import type {
    ListCollectionBiddingBidBookInput,
    ListCollectionBiddingBidBookOutput,
} from "../../../application/use-cases/trading/list-collection-bidding-bid-book.js";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "../../../application/use-cases/trading/bidding-bid-book.js";
import {
    getSearchParams,
    parseCollectionBiddingBidScopeFilter,
    parseCollectionBiddingTraitFilterJoinMode,
    parseCursor,
    parseLimit,
    parseMaker,
    parseMediaMode,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type ListCollectionBiddingBidBookRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Querystring: {
        bid_scope?: string;
        cursor?: string;
        limit?: string;
        maker?: string;
        media_mode?: string;
        trait_join?: string;
        traits?: string | string[];
        trait?: string | string[];
        trait_ranges?: string | string[];
        trait_range?: string | string[];
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ListCollectionBiddingBidBookHttpAdapter {
    constructor(
        readonly listCollectionBiddingBidBookPort: {
            listCollectionBiddingBidBook(
                input: ListCollectionBiddingBidBookInput,
            ): MaybePromise<ListCollectionBiddingBidBookOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListCollectionBiddingBidBookRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        return await this.listCollectionBiddingBidBookPort.listCollectionBiddingBidBook(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
                scopeFilter: parseCollectionBiddingBidScopeFilter(
                    searchParams.get("bid_scope"),
                ),
                traitFilterJoinMode: parseCollectionBiddingTraitFilterJoinMode(
                    searchParams.get("trait_join"),
                ),
                traits: parseTraits(searchParams),
                traitRanges: parseTraitRanges(searchParams),
                makerAddress: parseMaker(searchParams.get("maker")),
                mediaMode: parseMediaMode(searchParams.get("media_mode")),
                limit: parseLimit(searchParams.get("limit")),
                cursor: parseCursor(searchParams.get("cursor")),
            },
        );
    };
}

// Captures low-cardinality bidding request shape for slow-route traces.
export function getCollectionBiddingBidBookSpanAttributes(
    request: FastifyRequest<ListCollectionBiddingBidBookRoute>,
): SpanAttributes {
    const searchParams = getSearchParams(request);
    return {
        "artgod.bidding.scope_filter": normalizeScopeFilterAttribute(
            searchParams.get("bid_scope"),
        ),
        "artgod.bidding.trait_join": normalizeTraitJoinAttribute(
            searchParams.get("trait_join"),
        ),
        "artgod.bidding.limit": parseLimitAttribute(searchParams.get("limit")),
        "artgod.bidding.limit_present": hasQueryValue(searchParams, "limit"),
        "artgod.bidding.cursor_present": hasQueryValue(searchParams, "cursor"),
        "artgod.bidding.maker_filter_present": hasQueryValue(
            searchParams,
            "maker",
        ),
        "artgod.bidding.trait_filters_count": countDelimitedQuerySegments(
            searchParams,
            ["traits", "trait"],
        ),
        "artgod.bidding.trait_ranges_count": countDelimitedQuerySegments(
            searchParams,
            ["trait_ranges", "trait_range"],
        ),
        "artgod.bidding.media_mode_present": hasQueryValue(
            searchParams,
            COLLECTION_MEDIA_QUERY_PARAMS.MediaMode,
        ),
    };
}

function normalizeScopeFilterAttribute(raw: string | null): string {
    const value = raw?.trim();
    if (!value) return COLLECTION_BIDDING_BID_SCOPE_FILTER.Token;
    return value === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token ||
        value === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection ||
        value === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
        ? value
        : "invalid";
}

function normalizeTraitJoinAttribute(raw: string | null): string {
    const value = raw?.trim();
    if (!value) return COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or;
    return value === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or ||
        value === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
        ? value
        : "invalid";
}

function parseLimitAttribute(raw: string | null): number | undefined {
    const value = raw?.trim();
    if (!value || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
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
