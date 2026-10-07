import type { FastifyRequest } from "fastify";
import type {
    GetTokenCardInput,
    GetTokenCardOutput,
} from "../../../application/use-cases/collections/get-token-card.js";
import {
    getSearchParams,
    parseMediaMode,
    parseMediaPreference,
} from "../../common/request-query.js";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";

export type GetTokenCardRoute = {
    Params: { chain_ref: string; collection_ref: string; token_ref: string };
};

export class GetTokenCardHttpAdapter {
    constructor(
        private readonly cards: {
            getTokenCard(input: GetTokenCardInput): GetTokenCardOutput;
        },
    ) {}
    readonly handle = async (
        request: FastifyRequest<GetTokenCardRoute>,
    ): Promise<GetTokenCardOutput> => {
        const query = getSearchParams(request);
        return this.cards.getTokenCard({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
            mediaMode: parseMediaMode(
                query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
            ),
            mediaPreference: parseMediaPreference(
                query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference),
            ),
        });
    };
}
