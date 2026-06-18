import type { FastifyRequest } from "fastify";
import type { BootstrapRunDetailOutput } from "../../../application/use-cases/bootstrap/types.js";
import { parseBootstrapRunId } from "./request-parsing.js";

export type GetBootstrapRunDetailRoute = {
    Params: {
        chain_ref: string;
        run_id: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetBootstrapRunDetailHttpAdapter {
    constructor(
        private readonly getBootstrapRunDetailPort: {
            getRunDetail(input: {
                chainRef: string;
                runId: number;
            }): MaybePromise<BootstrapRunDetailOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetBootstrapRunDetailRoute>,
    ) => {
        return this.getBootstrapRunDetailPort.getRunDetail({
            chainRef: request.params.chain_ref,
            runId: parseBootstrapRunId(request.params.run_id),
        });
    };
}
