import type { FastifyRequest } from "fastify";
import type {
    GetCollectionDetailInput,
    GetCollectionDetailOutput,
    GetCollectionDetailPort,
} from "../../../application/use-cases/collections/get-collection-detail.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
    parseMediaMode,
    parseOwner,
    parseTokenBrowserStatus,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type GetCollectionDetailRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

export class GetCollectionDetailHttpAdapter {
    constructor(readonly getCollectionDetailPort: GetCollectionDetailPort) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionDetailRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionDetailPort.getCollectionDetail(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionDetailRoute>,
    ): GetCollectionDetailInput {
        const searchParams = getSearchParams(request);
        const tokenStatus = parseTokenBrowserStatus(
            searchParams.get("token_status"),
        );
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        const owner = parseOwner(searchParams.get("owner"));
        const traits = parseTraits(searchParams);
        const traitRanges = parseTraitRanges(searchParams);
        const mediaMode = parseMediaMode(searchParams.get("media_mode"));

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenStatus,
            limit,
            cursor: cursor ?? undefined,
            traits,
            traitRanges,
            owner,
            mediaMode,
        };
    }

    private mapOutputToResponse(
        output: GetCollectionDetailOutput,
    ): GetCollectionDetailOutput {
        return output;
    }
}
