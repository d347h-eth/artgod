import type { FastifyRequest } from "fastify";
import type {
    ArchiveBiddingJobInput,
    ArchiveBiddingJobOutput,
} from "../../../application/use-cases/trading/archive-bidding-job.js";

export type ArchiveBiddingJobRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        job_id: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ArchiveBiddingJobHttpAdapter {
    constructor(
        readonly archiveBiddingJobPort: {
            archiveBiddingJob(
                input: ArchiveBiddingJobInput,
            ): MaybePromise<ArchiveBiddingJobOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ArchiveBiddingJobRoute>,
    ) => {
        return await this.archiveBiddingJobPort.archiveBiddingJob({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            jobId: request.params.job_id,
        });
    };
}
