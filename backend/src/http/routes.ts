import type { FastifyInstance } from "fastify";
import type { ApiRouteHandlers } from "./handlers.js";
import type {
    ChainsDefaultRoute,
    CollectionDetailRoute,
    CollectionsRoute,
} from "./types.js";

export function registerApiRoutes(
    app: FastifyInstance,
    handlers: ApiRouteHandlers,
): void {
    app.options("/api/*", handlers.optionsApi);
    app.get<ChainsDefaultRoute>("/api/chains/default", handlers.getDefaultChain);
    app.get<CollectionsRoute>(
        "/api/:chain_ref/collections",
        handlers.listCollections,
    );
    app.get<CollectionDetailRoute>(
        "/api/:chain_ref/:collection_ref",
        handlers.getCollectionDetail,
    );
}
