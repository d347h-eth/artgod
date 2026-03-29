import type { FastifyRequest } from "fastify";
import type {
    GetTokenPreviewInput,
    GetTokenPreviewOutput,
    GetTokenPreviewPort,
} from "../../../application/use-cases/collections/get-token-preview.js";
import {
    getSearchParams,
    parseMediaMode,
} from "../../common/request-query.js";

export type GetTokenPreviewRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

export class GetTokenPreviewHttpAdapter {
    constructor(private readonly getTokenPreviewPort: GetTokenPreviewPort) {}

    readonly handle = async (request: FastifyRequest<GetTokenPreviewRoute>) => {
        const input = this.mapRequestToInput(request);
        const output = await this.getTokenPreviewPort.getTokenPreview(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetTokenPreviewRoute>,
    ): GetTokenPreviewInput {
        const searchParams = getSearchParams(request);
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
            mediaMode: parseMediaMode(searchParams.get("media_mode")),
        };
    }

    private mapOutputToResponse(
        output: GetTokenPreviewOutput,
    ): GetTokenPreviewOutput {
        return output;
    }
}
