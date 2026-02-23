import type { FastifyRequest } from "fastify";
import type { GetDefaultChainOutput } from "../../../application/use-cases/chains/get-default-chain.js";

export type GetDefaultChainRoute = {
    Params: Record<string, never>;
};

type MaybePromise<T> = T | Promise<T>;

export class GetDefaultChainHttpAdapter {
    constructor(
        readonly getDefaultChainPort: {
            getDefaultChain(): MaybePromise<GetDefaultChainOutput>;
        },
    ) {}

    readonly handle = async (
        _request: FastifyRequest<GetDefaultChainRoute>,
    ) => {
        const output = await this.getDefaultChainPort.getDefaultChain();
        return this.mapOutputToResponse(output);
    };

    private mapOutputToResponse(
        output: GetDefaultChainOutput,
    ): GetDefaultChainOutput {
        return output;
    }
}
