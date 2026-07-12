import type { FastifyRequest } from "fastify";
import type {
    ListActiveBiddingJobCeilingsInput,
    ListActiveBiddingJobCeilingsOutput,
} from "../../../application/use-cases/trading/list-active-bidding-job-ceilings.js";

export type ListActiveBiddingJobCeilingsRoute = {
    Params: {
        chain_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

// Maps the active-ceiling HTTP read into its transport-agnostic use case.
export class ListActiveBiddingJobCeilingsHttpAdapter {
    constructor(
        readonly listActiveBiddingJobCeilingsPort: {
            listActiveBiddingJobCeilings(
                input: ListActiveBiddingJobCeilingsInput,
            ): MaybePromise<ListActiveBiddingJobCeilingsOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ListActiveBiddingJobCeilingsRoute>,
    ) => {
        return await this.listActiveBiddingJobCeilingsPort.listActiveBiddingJobCeilings(
            {
                chainRef: request.params.chain_ref,
            },
        );
    };
}
