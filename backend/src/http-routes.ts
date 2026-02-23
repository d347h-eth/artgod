import type { FastifyInstance } from "fastify";
import type { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import type { GetDefaultChainRoute } from "./http/handlers/chains/get-default-chain.js";
import type {
    GetCollectionDetailHttpAdapter,
    GetCollectionDetailRoute,
} from "./http/handlers/collections/get-collection-detail.js";
import type {
    ListCollectionsHttpAdapter,
    ListCollectionsRoute,
} from "./http/handlers/collections/list-collections.js";
import type { CommonHttpHandlers } from "./http/common/handlers.js";

export function registerApiRoutes(
    app: FastifyInstance,
    commonHandlers: CommonHttpHandlers,
    getDefaultChainAdapter: GetDefaultChainHttpAdapter,
    listCollectionsAdapter: ListCollectionsHttpAdapter,
    getCollectionDetailAdapter: GetCollectionDetailHttpAdapter,
): void {
    app.options("/api/*", commonHandlers.optionsApi);
    app.get<GetDefaultChainRoute>(
        "/api/chains/default",
        getDefaultChainAdapter.handle,
    );
    app.get<ListCollectionsRoute>(
        "/api/:chain_ref/collections",
        listCollectionsAdapter.handle,
    );
    app.get<GetCollectionDetailRoute>(
        "/api/:chain_ref/:collection_ref",
        getCollectionDetailAdapter.handle,
    );
}
