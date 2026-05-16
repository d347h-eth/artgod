import type { FastifyRequest } from "fastify";
import type { GetRuntimeConfigOutput } from "../../../application/use-cases/config/get-runtime-config.js";

export type GetRuntimeConfigRoute = {
    Params: Record<string, never>;
};

type MaybePromise<T> = T | Promise<T>;

export class GetRuntimeConfigHttpAdapter {
    constructor(
        private readonly getRuntimeConfigPort: {
            getConfig(): MaybePromise<GetRuntimeConfigOutput>;
        },
    ) {}

    readonly handle = async (
        _request: FastifyRequest<GetRuntimeConfigRoute>,
    ) => {
        const output = await this.getRuntimeConfigPort.getConfig();
        return this.mapOutputToResponse(output);
    };

    private mapOutputToResponse(
        output: GetRuntimeConfigOutput,
    ): GetRuntimeConfigOutput {
        return output;
    }
}
