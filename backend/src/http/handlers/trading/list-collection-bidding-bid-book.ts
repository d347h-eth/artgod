import type { FastifyRequest } from "fastify";
import type {
    ListCollectionBiddingBidBookInput,
    ListCollectionBiddingBidBookOutput,
} from "../../../application/use-cases/trading/list-collection-bidding-bid-book.js";
import {
    getSearchParams,
    parseCollectionBiddingBidScopeFilter,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type ListCollectionBiddingBidBookRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
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
                traits: parseTraits(searchParams),
                traitRanges: parseTraitRanges(searchParams),
            },
        );
    };
}
