import type { FastifyRequest } from "fastify";
import type {
    ListBiddingJobCeilingPrefillsInput,
    ListBiddingJobCeilingPrefillsOutput,
} from "../../../application/use-cases/trading/list-bidding-job-ceiling-prefills.js";

export type ListBiddingJobCeilingPrefillsRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

// Maps the ceiling-prefill HTTP read into its transport-agnostic use case.
export class ListBiddingJobCeilingPrefillsHttpAdapter {
    constructor(
        readonly listBiddingJobCeilingPrefillsPort: {
            listBiddingJobCeilingPrefills(
                input: ListBiddingJobCeilingPrefillsInput,
            ): MaybePromise<ListBiddingJobCeilingPrefillsOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListBiddingJobCeilingPrefillsRoute>,
    ) => {
        return await this.listBiddingJobCeilingPrefillsPort.listBiddingJobCeilingPrefills(
            {
                chainRef: request.params.chain_ref,
            },
        );
    };
}
