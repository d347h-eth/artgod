import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { BootstrapRunDetailOutput } from "../../../application/use-cases/bootstrap/types.js";

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
            runId: parseRunId(request.params.run_id),
        });
    };
}

function parseRunId(raw: string): number {
    const value = raw.trim();
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ReadModelBadRequestError("Invalid run_id");
    }
    return parsed;
}
