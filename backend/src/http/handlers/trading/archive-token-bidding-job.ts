import type { FastifyRequest } from "fastify";
import type {
    ArchiveTokenBiddingJobInput,
    ArchiveTokenBiddingJobOutput,
} from "../../../application/use-cases/trading/archive-token-bidding-job.js";

export type ArchiveTokenBiddingJobRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ArchiveTokenBiddingJobHttpAdapter {
    constructor(
        readonly archiveTokenBiddingJobPort: {
            archiveTokenBiddingJob(
                input: ArchiveTokenBiddingJobInput,
            ): MaybePromise<ArchiveTokenBiddingJobOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ArchiveTokenBiddingJobRoute>,
    ) => {
        return await this.archiveTokenBiddingJobPort.archiveTokenBiddingJob({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
        });
    };
}
