import type { FastifyRequest } from "fastify";
import type {
    GetTokenBiddingBidBookInput,
    GetTokenBiddingBidBookOutput,
} from "../../../application/use-cases/trading/get-token-bidding-bid-book.js";

export type GetTokenBiddingBidBookRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetTokenBiddingBidBookHttpAdapter {
    constructor(
        readonly getTokenBiddingBidBookPort: {
            getTokenBiddingBidBook(
                input: GetTokenBiddingBidBookInput,
            ): MaybePromise<GetTokenBiddingBidBookOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetTokenBiddingBidBookRoute>,
    ) => {
        return await this.getTokenBiddingBidBookPort.getTokenBiddingBidBook({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
        });
    };
}
