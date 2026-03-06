import Fastify, { type FastifyInstance } from "fastify";
import type { CreateBootstrapRunUseCase } from "./application/use-cases/bootstrap/create-bootstrap-run.js";
import type { GetBootstrapRunDetailUseCase } from "./application/use-cases/bootstrap/get-bootstrap-run-detail.js";
import type { GetBootstrapStatusUseCase } from "./application/use-cases/bootstrap/get-bootstrap-status.js";
import type { ListBootstrapRunsUseCase } from "./application/use-cases/bootstrap/list-bootstrap-runs.js";
import type { RetryBootstrapRunFailedTasksUseCase } from "./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";
import type { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import type { GetCollectionDetailUseCase } from "./application/use-cases/collections/get-collection-detail.js";
import type { GetTokenDetailUseCase } from "./application/use-cases/collections/get-token-detail.js";
import type { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import type { GetRuntimeHealthUseCase } from "./application/use-cases/health/get-runtime-health.js";
import { CreateBootstrapRunHttpAdapter } from "./http/handlers/bootstrap/create-bootstrap-run.js";
import { GetBootstrapRunDetailHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-run-detail.js";
import { GetBootstrapStatusHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-status.js";
import { ListBootstrapRunsHttpAdapter } from "./http/handlers/bootstrap/list-bootstrap-runs.js";
import { RetryBootstrapRunFailedTasksHttpAdapter } from "./http/handlers/bootstrap/retry-bootstrap-run-failed-tasks.js";
import { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import { GetCollectionDetailHttpAdapter } from "./http/handlers/collections/get-collection-detail.js";
import { GetTokenDetailHttpAdapter } from "./http/handlers/collections/get-token-detail.js";
import { ListCollectionsHttpAdapter } from "./http/handlers/collections/list-collections.js";
import { GetRuntimeHealthHttpAdapter } from "./http/handlers/health/get-runtime-health.js";
import { createCommonHttpHandlers } from "./http/common/handlers.js";
import { registerApiErrorHandlers } from "./http/common/error-handlers.js";
import { registerApiResponseHeaders } from "./http/common/response-headers.js";
import { registerApiSecurityHooks } from "./http/common/security.js";
import { registerUserlandStaticRoutes } from "./http/common/userland-static.js";
import { registerApiRoutes } from "./http-routes.js";

export function createApiApp(
    createBootstrapRunUseCase: CreateBootstrapRunUseCase,
    listBootstrapRunsUseCase: ListBootstrapRunsUseCase,
    getBootstrapRunDetailUseCase: GetBootstrapRunDetailUseCase,
    getBootstrapStatusUseCase: GetBootstrapStatusUseCase,
    retryBootstrapRunFailedTasksUseCase: RetryBootstrapRunFailedTasksUseCase,
    getDefaultChainUseCase: GetDefaultChainUseCase,
    listCollectionsUseCase: ListCollectionsUseCase,
    getCollectionDetailUseCase: GetCollectionDetailUseCase,
    getTokenDetailUseCase: GetTokenDetailUseCase,
    getRuntimeHealthUseCase: GetRuntimeHealthUseCase,
    userlandUiDistDir: string | null,
): FastifyInstance {
    const app = Fastify({
        logger: false,
    });

    const commonHandlers = createCommonHttpHandlers();
    const createBootstrapRunAdapter = new CreateBootstrapRunHttpAdapter(
        createBootstrapRunUseCase,
    );
    const listBootstrapRunsAdapter = new ListBootstrapRunsHttpAdapter(
        listBootstrapRunsUseCase,
    );
    const getBootstrapRunDetailAdapter = new GetBootstrapRunDetailHttpAdapter(
        getBootstrapRunDetailUseCase,
    );
    const getBootstrapStatusAdapter = new GetBootstrapStatusHttpAdapter(
        getBootstrapStatusUseCase,
    );
    const retryBootstrapRunFailedTasksAdapter =
        new RetryBootstrapRunFailedTasksHttpAdapter(
            retryBootstrapRunFailedTasksUseCase,
        );
    const getDefaultChainAdapter = new GetDefaultChainHttpAdapter(
        getDefaultChainUseCase,
    );
    const listCollectionsAdapter = new ListCollectionsHttpAdapter(
        listCollectionsUseCase,
    );
    const getCollectionDetailAdapter = new GetCollectionDetailHttpAdapter(
        getCollectionDetailUseCase,
    );
    const getTokenDetailAdapter = new GetTokenDetailHttpAdapter(
        getTokenDetailUseCase,
    );
    const getRuntimeHealthAdapter = new GetRuntimeHealthHttpAdapter(
        getRuntimeHealthUseCase,
    );

    registerApiResponseHeaders(app);
    registerApiSecurityHooks(app);
    registerApiRoutes(
        app,
        commonHandlers,
        createBootstrapRunAdapter,
        listBootstrapRunsAdapter,
        getBootstrapRunDetailAdapter,
        getBootstrapStatusAdapter,
        retryBootstrapRunFailedTasksAdapter,
        getDefaultChainAdapter,
        listCollectionsAdapter,
        getCollectionDetailAdapter,
        getTokenDetailAdapter,
        getRuntimeHealthAdapter,
    );
    if (userlandUiDistDir) {
        registerUserlandStaticRoutes(app, userlandUiDistDir);
    }
    registerApiErrorHandlers(app);

    return app;
}
