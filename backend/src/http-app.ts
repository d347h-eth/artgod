import Fastify, { type FastifyInstance } from "fastify";
import type { CreateBootstrapRunUseCase } from "./application/use-cases/bootstrap/create-bootstrap-run.js";
import type { GetBootstrapStatusUseCase } from "./application/use-cases/bootstrap/get-bootstrap-status.js";
import type { ListBootstrapMetadataTasksUseCase } from "./application/use-cases/bootstrap/list-bootstrap-metadata-tasks.js";
import type { RestartBootstrapRunUseCase } from "./application/use-cases/bootstrap/restart-bootstrap-run.js";
import type { RetryBootstrapFailedTasksUseCase } from "./application/use-cases/bootstrap/retry-bootstrap-failed-tasks.js";
import type { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import type { GetCollectionDetailUseCase } from "./application/use-cases/collections/get-collection-detail.js";
import type { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import type { GetRuntimeHealthUseCase } from "./application/use-cases/health/get-runtime-health.js";
import { CreateBootstrapRunHttpAdapter } from "./http/handlers/bootstrap/create-bootstrap-run.js";
import { GetBootstrapStatusHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-status.js";
import { ListBootstrapMetadataTasksHttpAdapter } from "./http/handlers/bootstrap/list-bootstrap-metadata-tasks.js";
import { RestartBootstrapRunHttpAdapter } from "./http/handlers/bootstrap/restart-bootstrap-run.js";
import { RetryBootstrapFailedTasksHttpAdapter } from "./http/handlers/bootstrap/retry-bootstrap-failed-tasks.js";
import { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import { GetCollectionDetailHttpAdapter } from "./http/handlers/collections/get-collection-detail.js";
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
    getBootstrapStatusUseCase: GetBootstrapStatusUseCase,
    listBootstrapMetadataTasksUseCase: ListBootstrapMetadataTasksUseCase,
    retryBootstrapFailedTasksUseCase: RetryBootstrapFailedTasksUseCase,
    restartBootstrapRunUseCase: RestartBootstrapRunUseCase,
    getDefaultChainUseCase: GetDefaultChainUseCase,
    listCollectionsUseCase: ListCollectionsUseCase,
    getCollectionDetailUseCase: GetCollectionDetailUseCase,
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
    const getBootstrapStatusAdapter = new GetBootstrapStatusHttpAdapter(
        getBootstrapStatusUseCase,
    );
    const listBootstrapMetadataTasksAdapter =
        new ListBootstrapMetadataTasksHttpAdapter(
            listBootstrapMetadataTasksUseCase,
        );
    const retryBootstrapFailedTasksAdapter =
        new RetryBootstrapFailedTasksHttpAdapter(
            retryBootstrapFailedTasksUseCase,
        );
    const restartBootstrapRunAdapter = new RestartBootstrapRunHttpAdapter(
        restartBootstrapRunUseCase,
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
    const getRuntimeHealthAdapter = new GetRuntimeHealthHttpAdapter(
        getRuntimeHealthUseCase,
    );

    registerApiResponseHeaders(app);
    registerApiSecurityHooks(app);
    registerApiRoutes(
        app,
        commonHandlers,
        createBootstrapRunAdapter,
        getBootstrapStatusAdapter,
        listBootstrapMetadataTasksAdapter,
        retryBootstrapFailedTasksAdapter,
        restartBootstrapRunAdapter,
        getDefaultChainAdapter,
        listCollectionsAdapter,
        getCollectionDetailAdapter,
        getRuntimeHealthAdapter,
    );
    if (userlandUiDistDir) {
        registerUserlandStaticRoutes(app, userlandUiDistDir);
    }
    registerApiErrorHandlers(app);

    return app;
}
