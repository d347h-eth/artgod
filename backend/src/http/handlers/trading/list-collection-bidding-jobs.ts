import type { FastifyRequest } from "fastify";
import type {
    ListCollectionBiddingJobsInput,
    ListCollectionBiddingJobsOutput,
} from "../../../application/use-cases/trading/list-collection-bidding-jobs.js";

export type ListCollectionBiddingJobsRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ListCollectionBiddingJobsHttpAdapter {
    constructor(
        readonly listCollectionBiddingJobsPort: {
            listCollectionBiddingJobs(
                input: ListCollectionBiddingJobsInput,
            ): MaybePromise<ListCollectionBiddingJobsOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListCollectionBiddingJobsRoute>,
    ) => {
        return await this.listCollectionBiddingJobsPort.listCollectionBiddingJobs(
            {
                chainRef: request.params.chain_ref,
                collectionRef: request.params.collection_ref,
            },
        );
    };
}
