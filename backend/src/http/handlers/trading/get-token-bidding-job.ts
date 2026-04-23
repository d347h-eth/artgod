import type { FastifyRequest } from "fastify";
import type {
    GetTokenBiddingJobInput,
    GetTokenBiddingJobOutput,
} from "../../../application/use-cases/trading/get-token-bidding-job.js";

export type GetTokenBiddingJobRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetTokenBiddingJobHttpAdapter {
    constructor(
        readonly getTokenBiddingJobPort: {
            getTokenBiddingJob(
                input: GetTokenBiddingJobInput,
            ): MaybePromise<GetTokenBiddingJobOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetTokenBiddingJobRoute>,
    ) => {
        return await this.getTokenBiddingJobPort.getTokenBiddingJob({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
        });
    };
}
