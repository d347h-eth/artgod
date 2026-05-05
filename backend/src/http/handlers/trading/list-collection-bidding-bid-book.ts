import type { FastifyRequest } from "fastify";
import type {
    ListCollectionBiddingBidBookInput,
    ListCollectionBiddingBidBookOutput,
} from "../../../application/use-cases/trading/list-collection-bidding-bid-book.js";
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
