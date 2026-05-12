import type { FastifyRequest } from "fastify";
import type {
    ListCollectionBiddingPriceTiersInput,
    ListCollectionBiddingPriceTiersOutput,
} from "../../../application/use-cases/trading/list-collection-bidding-price-tiers.js";

export type ListCollectionBiddingPriceTiersRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ListCollectionBiddingPriceTiersHttpAdapter {
    constructor(
        readonly listCollectionBiddingPriceTiersPort: {
            listCollectionBiddingPriceTiers(
                input: ListCollectionBiddingPriceTiersInput,
            ): MaybePromise<ListCollectionBiddingPriceTiersOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListCollectionBiddingPriceTiersRoute>,
    ) => {
        return await this.listCollectionBiddingPriceTiersPort.listCollectionBiddingPriceTiers(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
            },
        );
    };
}
