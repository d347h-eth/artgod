import type { FastifyReply, FastifyRequest } from "fastify";
import type {
    ApiRouteDependencies,
    ChainsDefaultRoute,
    CollectionDetailRoute,
    CollectionsRoute,
} from "./types.js";
import {
    getSearchParams,
    parseCursor,
    parseLimit,
    parseStatus,
    parseTraits,
} from "../utils/http-query.js";

export type ApiRouteHandlers = {
    optionsApi: (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => Promise<void>;
    getDefaultChain: (
        request: FastifyRequest<ChainsDefaultRoute>,
    ) => Promise<unknown>;
    listCollections: (
        request: FastifyRequest<CollectionsRoute>,
    ) => Promise<unknown>;
    getCollectionDetail: (
        request: FastifyRequest<CollectionDetailRoute>,
    ) => Promise<unknown>;
};

export function createApiRouteHandlers(
    dependencies: ApiRouteDependencies,
): ApiRouteHandlers {
    return {
        optionsApi: async (_request, reply) => {
            reply.code(204).send();
        },

        getDefaultChain: async () => {
            const chain = dependencies.chainsReadModel.getDefaultChain(
                dependencies.defaultChainId,
            );
            return { chain };
        },

        listCollections: async (request) => {
            const searchParams = getSearchParams(request);
            const status = parseStatus(searchParams.get("status"));
            const limit = parseLimit(searchParams.get("limit"));
            const cursor = parseCursor(searchParams.get("cursor"));

            const chain = dependencies.chainsReadModel.resolveChainRef(
                request.params.chain_ref,
                dependencies.defaultChainId,
            );

            const page = dependencies.collectionsReadModel.listCollections({
                chainId: chain.publicChainId,
                status,
                limit,
                cursor: cursor ?? undefined,
            });

            return {
                chain,
                filters: { status },
                page,
            };
        },

        getCollectionDetail: async (request) => {
            const searchParams = getSearchParams(request);
            const limit = parseLimit(searchParams.get("limit"));
            const cursor = parseCursor(searchParams.get("cursor"));
            const traits = parseTraits(searchParams);

            const chain = dependencies.chainsReadModel.resolveChainRef(
                request.params.chain_ref,
                dependencies.defaultChainId,
            );

            const collection = dependencies.collectionsReadModel.resolveCollectionRef(
                chain.publicChainId,
                request.params.collection_ref,
            );

            const tokens = dependencies.collectionsReadModel.listCollectionTokens({
                chainId: chain.publicChainId,
                contractAddress: collection.address,
                limit,
                cursor: cursor ?? undefined,
                traitFilters: traits,
            });

            const facets = dependencies.collectionsReadModel.listCollectionTraitFacets(
                chain.publicChainId,
                collection.address,
            );

            return {
                chain,
                collection,
                traits: {
                    selected: traits,
                    facets,
                },
                tokens,
            };
        },
    };
}
