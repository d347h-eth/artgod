import type { FastifyRequest } from "fastify";
import type {
    GetTokenActivityInput,
    GetTokenActivityOutput,
} from "../../../application/use-cases/activities/get-token-activity.js";
import {
    parseActivityFilterKind,
    getSearchParams,
    parseCursor,
    parseLimit,
    parseMediaMode,
    parseMediaPreference,
} from "../../common/request-query.js";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";

export type GetTokenActivityRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetTokenActivityHttpAdapter {
    constructor(
        readonly getTokenActivityPort: {
            getTokenActivity(
                input: GetTokenActivityInput,
            ): MaybePromise<GetTokenActivityOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetTokenActivityRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output = await this.getTokenActivityPort.getTokenActivity(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetTokenActivityRoute>,
    ): GetTokenActivityInput {
        const searchParams = getSearchParams(request);
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        const kind = parseActivityFilterKind(searchParams.get("kind"));
        const mediaMode = parseMediaMode(
            searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
        );
        const mediaPreference = parseMediaPreference(
            searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference),
        );

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
            limit,
            cursor: cursor ?? undefined,
            kind,
            mediaMode,
            mediaPreference,
        };
    }

    private mapOutputToResponse(
        output: GetTokenActivityOutput,
    ): GetTokenActivityOutput {
        return output;
    }
}
