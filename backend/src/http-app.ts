import Fastify, { type FastifyInstance } from "fastify";
import { createApiRouteHandlers } from "./http/handlers.js";
import { registerApiErrorHandlers } from "./http/error-handlers.js";
import { registerApiResponseHeaders } from "./http/response-headers.js";
import { registerApiRoutes } from "./http/routes.js";
import type { ApiRouteDependencies } from "./http/types.js";

export type { ApiRouteDependencies } from "./http/types.js";

export function createApiApp(
    dependencies: ApiRouteDependencies,
): FastifyInstance {
    const app = Fastify({
        logger: false,
    });

    const handlers = createApiRouteHandlers(dependencies);

    registerApiResponseHeaders(app);
    registerApiRoutes(app, handlers);
    registerApiErrorHandlers(app);

    return app;
}
