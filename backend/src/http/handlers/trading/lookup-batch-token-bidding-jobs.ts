import type { FastifyRequest } from "fastify";
import type {
    LookupBatchTokenBiddingJobsInput,
    LookupBatchTokenBiddingJobsOutput,
} from "../../../application/use-cases/trading/lookup-batch-token-bidding-jobs.js";
import { parseBatchTokenBiddingJobSelection } from "./upsert-batch-token-bidding-jobs.js";

export type LookupBatchTokenBiddingJobsRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        selection?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class LookupBatchTokenBiddingJobsHttpAdapter {
    constructor(
        readonly lookupBatchTokenBiddingJobsPort: {
            lookupBatchTokenBiddingJobs(
                input: LookupBatchTokenBiddingJobsInput,
            ): MaybePromise<LookupBatchTokenBiddingJobsOutput>;
        },
        private readonly includeOwnJobContext: boolean,
    ) {}

    readonly handle = async (
        request: FastifyRequest<LookupBatchTokenBiddingJobsRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.lookupBatchTokenBiddingJobsPort.lookupBatchTokenBiddingJobs(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<LookupBatchTokenBiddingJobsRoute>,
    ): LookupBatchTokenBiddingJobsInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            includeOwnJobContext: this.includeOwnJobContext,
            selection: parseBatchTokenBiddingJobSelection(
                request.body?.selection,
            ),
        };
    }
}
