import type { FastifyRequest } from "fastify";
import { PAGINATION_QUERY_PARAMS } from "@artgod/shared/config/pagination";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import type { SpanAttributes } from "@artgod/shared/observability/apm";
import {
    COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
    TRAIT_FILTER_QUERY_PARAMS,
} from "@artgod/shared/types";
import type {
    ListCollectionBiddingBidBookInput,
    ListCollectionBiddingBidBookOutput,
} from "../../../application/use-cases/trading/list-collection-bidding-bid-book.js";
import {
    BIDDING_SPAN_ATTRIBUTE,
    TRACE_ATTRIBUTE_VALUE,
} from "../../../application/use-cases/trading/bidding-observability.js";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "../../../application/use-cases/trading/bidding-bid-book.js";
import {
    getSearchParams,
    parseCollectionBiddingBidScopeFilter,
    parseCollectionBiddingBidBookOwnershipFilter,
    parseCollectionBiddingTraitFilterJoinMode,
    parseCursor,
    parseLimit,
    parseMaker,
    parseMediaMode,
    parseMediaPreference,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type ListCollectionBiddingBidBookRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Querystring: {
        [COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope]?: string;
        [PAGINATION_QUERY_PARAMS.Cursor]?: string;
        [PAGINATION_QUERY_PARAMS.Limit]?: string;
        [COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Maker]?: string;
        [COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership]?: string;
        [COLLECTION_MEDIA_QUERY_PARAMS.MediaMode]?: string;
        [COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference]?: string;
        [COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.TraitJoin]?: string;
        [TRAIT_FILTER_QUERY_PARAMS.Traits]?: string | string[];
        [TRAIT_FILTER_QUERY_PARAMS.Trait]?: string | string[];
        [TRAIT_FILTER_QUERY_PARAMS.TraitRanges]?: string | string[];
        [TRAIT_FILTER_QUERY_PARAMS.TraitRange]?: string | string[];
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
        private readonly includeOwnJobContext: boolean,
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListCollectionBiddingBidBookRoute>,
    ) => {
        const searchParams = getSearchParams(request);
        return await this.listCollectionBiddingBidBookPort.listCollectionBiddingBidBook(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
                includeOwnJobContext: this.includeOwnJobContext,
                scopeFilter: parseCollectionBiddingBidScopeFilter(
                    searchParams.get(
                        COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope,
                    ),
                ),
                traitFilterJoinMode: parseCollectionBiddingTraitFilterJoinMode(
                    searchParams.get(
                        COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.TraitJoin,
                    ),
                ),
                traits: parseTraits(searchParams),
                traitRanges: parseTraitRanges(searchParams),
                makerAddress: parseMaker(
                    searchParams.get(
                        COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Maker,
                    ),
                ),
                ownershipFilter: parseCollectionBiddingBidBookOwnershipFilter(
                    searchParams.get(
                        COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership,
                    ),
                ),
                mediaMode: parseMediaMode(
                    searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
                ),
                mediaPreference: parseMediaPreference(
                    searchParams.get(
                        COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference,
                    ),
                ),
                limit: parseLimit(
                    searchParams.get(PAGINATION_QUERY_PARAMS.Limit),
                ),
                cursor: parseCursor(
                    searchParams.get(PAGINATION_QUERY_PARAMS.Cursor),
                ),
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
        [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]: normalizeScopeFilterAttribute(
            searchParams.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope),
        ),
        [BIDDING_SPAN_ATTRIBUTE.TraitJoin]: normalizeTraitJoinAttribute(
            searchParams.get(
                COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.TraitJoin,
            ),
        ),
        [BIDDING_SPAN_ATTRIBUTE.Limit]: parseLimitAttribute(
            searchParams.get(PAGINATION_QUERY_PARAMS.Limit),
        ),
        [BIDDING_SPAN_ATTRIBUTE.LimitPresent]: hasQueryValue(
            searchParams,
            PAGINATION_QUERY_PARAMS.Limit,
        ),
        [BIDDING_SPAN_ATTRIBUTE.CursorPresent]: hasQueryValue(
            searchParams,
            PAGINATION_QUERY_PARAMS.Cursor,
        ),
        [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]: hasQueryValue(
            searchParams,
            COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Maker,
        ),
        [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]: countDelimitedQuerySegments(
            searchParams,
            [TRAIT_FILTER_QUERY_PARAMS.Traits, TRAIT_FILTER_QUERY_PARAMS.Trait],
        ),
        [BIDDING_SPAN_ATTRIBUTE.TraitRangesCount]: countDelimitedQuerySegments(
            searchParams,
            [
                TRAIT_FILTER_QUERY_PARAMS.TraitRanges,
                TRAIT_FILTER_QUERY_PARAMS.TraitRange,
            ],
        ),
        [BIDDING_SPAN_ATTRIBUTE.MediaModePresent]: hasQueryValue(
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
        : TRACE_ATTRIBUTE_VALUE.Invalid;
}

function normalizeTraitJoinAttribute(raw: string | null): string {
    const value = raw?.trim();
    if (!value) return COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or;
    return value === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or ||
        value === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
        ? value
        : TRACE_ATTRIBUTE_VALUE.Invalid;
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
