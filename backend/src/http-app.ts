import Fastify, { type FastifyInstance } from "fastify";
import type { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import type { GetCollectionDetailUseCase } from "./application/use-cases/collections/get-collection-detail.js";
import type { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import { GetCollectionDetailHttpAdapter } from "./http/handlers/collections/get-collection-detail.js";
import { ListCollectionsHttpAdapter } from "./http/handlers/collections/list-collections.js";
import { createCommonHttpHandlers } from "./http/common/handlers.js";
import { registerApiErrorHandlers } from "./http/common/error-handlers.js";
import { registerApiResponseHeaders } from "./http/common/response-headers.js";
import { registerApiRoutes } from "./http-routes.js";

export function createApiApp(
    getDefaultChainUseCase: GetDefaultChainUseCase,
    listCollectionsUseCase: ListCollectionsUseCase,
    getCollectionDetailUseCase: GetCollectionDetailUseCase,
): FastifyInstance {
    const app = Fastify({
        logger: false,
    });

    const commonHandlers = createCommonHttpHandlers();
    const getDefaultChainAdapter = new GetDefaultChainHttpAdapter(
        getDefaultChainUseCase,
    );
    const listCollectionsAdapter = new ListCollectionsHttpAdapter(
        listCollectionsUseCase,
    );
    const getCollectionDetailAdapter = new GetCollectionDetailHttpAdapter(
        getCollectionDetailUseCase,
    );

    registerApiResponseHeaders(app);
    registerApiRoutes(
        app,
        commonHandlers,
        getDefaultChainAdapter,
        listCollectionsAdapter,
        getCollectionDetailAdapter,
    );
    registerApiErrorHandlers(app);

    return app;
}
