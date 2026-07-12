import type { FastifyRequest } from "fastify";
import type {
    GetTokenPreviewInput,
    GetTokenPreviewOutput,
    GetTokenPreviewPort,
} from "../../../application/use-cases/collections/get-token-preview.js";
import {
    getSearchParams,
    parseMediaMode,
    parseMediaPreference,
    parseMediaVariant,
} from "../../common/request-query.js";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";

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
            mediaMode: parseMediaMode(
                searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
            ),
            mediaPreference: parseMediaPreference(
                searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference),
            ),
            mediaVariant: parseMediaVariant(
                searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant),
            ),
        };
    }

    private mapOutputToResponse(
        output: GetTokenPreviewOutput,
    ): GetTokenPreviewOutput {
        return output;
    }
}
