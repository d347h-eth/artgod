import type { FastifyReply, FastifyRequest } from "fastify";
import type { GetRuntimeHealthOutput } from "../../../application/use-cases/health/get-runtime-health.js";

export type GetRuntimeHealthRoute = {
    Params: Record<string, never>;
};

type MaybePromise<T> = T | Promise<T>;

export class GetRuntimeHealthHttpAdapter {
    constructor(
        readonly getRuntimeHealthPort: {
            getRuntimeHealth(): MaybePromise<GetRuntimeHealthOutput>;
        },
    ) {}

    readonly handle = async (
        _request: FastifyRequest<GetRuntimeHealthRoute>,
        reply: FastifyReply,
    ) => {
        const output = await this.getRuntimeHealthPort.getRuntimeHealth();
        if (!output.ok) {
            reply.code(503);
        }
        return this.mapOutputToResponse(output);
    };

    private mapOutputToResponse(
        output: GetRuntimeHealthOutput,
    ): GetRuntimeHealthOutput {
        return output;
    }
}
