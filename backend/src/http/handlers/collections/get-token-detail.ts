import type { FastifyRequest } from "fastify";
import type {
    GetTokenDetailInput,
    GetTokenDetailOutput,
} from "../../../application/use-cases/collections/get-token-detail.js";

export type GetTokenDetailRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetTokenDetailHttpAdapter {
    constructor(
        readonly getTokenDetailPort: {
            getTokenDetail(
                input: GetTokenDetailInput,
            ): MaybePromise<GetTokenDetailOutput>;
        },
    ) {}

    readonly handle = async (request: FastifyRequest<GetTokenDetailRoute>) => {
        const input = this.mapRequestToInput(request);
        const output = await this.getTokenDetailPort.getTokenDetail(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetTokenDetailRoute>,
    ): GetTokenDetailInput {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
        };
    }

    private mapOutputToResponse(
        output: GetTokenDetailOutput,
    ): GetTokenDetailOutput {
        return output;
    }
}
