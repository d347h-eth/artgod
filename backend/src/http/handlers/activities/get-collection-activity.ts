import type { FastifyRequest } from "fastify";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "@artgod/shared/extensions";
import { ACTIVITY_FEED_QUERY_PARAMS } from "@artgod/shared/types";
import type {
    GetCollectionActivityInput,
    GetCollectionActivityOutput,
} from "../../../application/use-cases/activities/get-collection-activity.js";
import {
    parseActivityFilterKind,
    parseActivityEventGroup,
    parseActivityTokenId,
    getSearchParams,
    parseContentHash,
    parseCursor,
    parseExtensionEventRef,
    parseLimit,
    parseMaker,
    parseMediaMode,
    parseTraits,
    parseTraitRanges,
} from "../../common/request-query.js";

export type GetCollectionActivityRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetCollectionActivityHttpAdapter {
    constructor(
        readonly getCollectionActivityPort: {
            getCollectionActivity(
                input: GetCollectionActivityInput,
            ): MaybePromise<GetCollectionActivityOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionActivityRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output =
            await this.getCollectionActivityPort.getCollectionActivity(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<GetCollectionActivityRoute>,
    ): GetCollectionActivityInput {
        const searchParams = getSearchParams(request);
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        const extensionEvent = parseExtensionEventRef(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.ExtensionEvent),
        );
        const kind = extensionEvent
            ? undefined
            : parseActivityFilterKind(
                  searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.Kind),
              );
        const traits = parseTraits(searchParams);
        const traitRanges = parseTraitRanges(searchParams);
        const mediaMode = parseMediaMode(
            searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
        );
        const tokenId = parseActivityTokenId(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.TokenId),
        );
        const maker = parseMaker(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.Maker),
        );
        const contentHash = parseContentHash(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.ContentHash),
        );
        const eventGroup = parseActivityEventGroup(
            searchParams.get(ACTIVITY_FEED_QUERY_PARAMS.EventGroup),
        );

        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            limit,
            cursor: cursor ?? undefined,
            kind,
            traits,
            traitRanges,
            mediaMode,
            tokenId,
            maker,
            contentHash,
            eventGroup,
            extensionEvent,
        };
    }

    private mapOutputToResponse(
        output: GetCollectionActivityOutput,
    ): GetCollectionActivityOutput {
        return output;
    }
}
