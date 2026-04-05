import Fastify, { type FastifyInstance } from "fastify";
import type { CreateBootstrapRunUseCase } from "./application/use-cases/bootstrap/create-bootstrap-run.js";
import type { GetBootstrapRunDetailUseCase } from "./application/use-cases/bootstrap/get-bootstrap-run-detail.js";
import type { GetBootstrapStatusUseCase } from "./application/use-cases/bootstrap/get-bootstrap-status.js";
import type { ListBootstrapRunsUseCase } from "./application/use-cases/bootstrap/list-bootstrap-runs.js";
import type { RetryBootstrapRunFailedTasksUseCase } from "./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";
import type { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import type { GetCollectionActivityUseCase } from "./application/use-cases/activities/get-collection-activity.js";
import type { GetTokenActivityUseCase } from "./application/use-cases/activities/get-token-activity.js";
import type { GetCollectionCustomizationUseCase } from "./application/use-cases/collections/get-collection-customization.js";
import type { GetCollectionDetailPort } from "./application/use-cases/collections/get-collection-detail.js";
import type { GetCollectionHoldersUseCase } from "./application/use-cases/collections/get-collection-holders.js";
import type { GetTokenDetailUseCase } from "./application/use-cases/collections/get-token-detail.js";
import type { GetTokenPreviewPort } from "./application/use-cases/collections/get-token-preview.js";
import type { UpdateCollectionCustomizationUseCase } from "./application/use-cases/collections/update-collection-customization.js";
import type { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import type { GetRuntimeHealthUseCase } from "./application/use-cases/health/get-runtime-health.js";
import type { ResolveOwnerRefUseCase } from "./application/use-cases/owners/resolve-owner-ref.js";
import { CreateBootstrapRunHttpAdapter } from "./http/handlers/bootstrap/create-bootstrap-run.js";
import { GetBootstrapRunDetailHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-run-detail.js";
import { GetBootstrapStatusHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-status.js";
import { ListBootstrapRunsHttpAdapter } from "./http/handlers/bootstrap/list-bootstrap-runs.js";
import { RetryBootstrapRunFailedTasksHttpAdapter } from "./http/handlers/bootstrap/retry-bootstrap-run-failed-tasks.js";
import { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import { GetCollectionActivityHttpAdapter } from "./http/handlers/activities/get-collection-activity.js";
import { GetTokenActivityHttpAdapter } from "./http/handlers/activities/get-token-activity.js";
import { GetCollectionCustomizationHttpAdapter } from "./http/handlers/collections/get-collection-customization.js";
import { GetCollectionDetailHttpAdapter } from "./http/handlers/collections/get-collection-detail.js";
import { GetCollectionHoldersHttpAdapter } from "./http/handlers/collections/get-collection-holders.js";
import { GetTokenDetailHttpAdapter } from "./http/handlers/collections/get-token-detail.js";
import { GetTokenPreviewHttpAdapter } from "./http/handlers/collections/get-token-preview.js";
import { UpdateCollectionCustomizationHttpAdapter } from "./http/handlers/collections/update-collection-customization.js";
import { ListCollectionsHttpAdapter } from "./http/handlers/collections/list-collections.js";
import { GetRuntimeHealthHttpAdapter } from "./http/handlers/health/get-runtime-health.js";
import { ResolveOwnerRefHttpAdapter } from "./http/handlers/owners/resolve-owner-ref.js";
import { createCommonHttpHandlers } from "./http/common/handlers.js";
import { registerApiErrorHandlers } from "./http/common/error-handlers.js";
import { registerApiResponseHeaders } from "./http/common/response-headers.js";
import {
    createIssueCsrfTokenHandler,
    registerApiSecurityHooks,
} from "./http/common/security.js";
import { registerUserlandStaticRoutes } from "./http/common/userland-static.js";
import { registerApiRoutes } from "./http-routes.js";
import type {
    BackendDeploymentConfig,
    BackendSecurityConfig,
} from "./config.js";

export function createApiApp(
    createBootstrapRunUseCase: CreateBootstrapRunUseCase,
    listBootstrapRunsUseCase: ListBootstrapRunsUseCase,
    getBootstrapRunDetailUseCase: GetBootstrapRunDetailUseCase,
    getBootstrapStatusUseCase: GetBootstrapStatusUseCase,
    retryBootstrapRunFailedTasksUseCase: RetryBootstrapRunFailedTasksUseCase,
    getDefaultChainUseCase: GetDefaultChainUseCase,
    listCollectionsUseCase: ListCollectionsUseCase,
    resolveOwnerRefUseCase: ResolveOwnerRefUseCase,
    getCollectionActivityUseCase: GetCollectionActivityUseCase,
    getTokenActivityUseCase: GetTokenActivityUseCase,
    getCollectionCustomizationUseCase: GetCollectionCustomizationUseCase,
    getCollectionDetailUseCase: GetCollectionDetailPort,
    getCollectionHoldersUseCase: GetCollectionHoldersUseCase,
    getTokenDetailUseCase: GetTokenDetailUseCase,
    getTokenPreviewUseCase: GetTokenPreviewPort,
    updateCollectionCustomizationUseCase: UpdateCollectionCustomizationUseCase,
    getRuntimeHealthUseCase: GetRuntimeHealthUseCase,
    userlandUiDistDir: string | null,
    securityConfig: BackendSecurityConfig,
    deploymentConfig: BackendDeploymentConfig,
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
    const resolveOwnerRefAdapter = new ResolveOwnerRefHttpAdapter(
        resolveOwnerRefUseCase,
    );
    const getCollectionActivityAdapter = new GetCollectionActivityHttpAdapter(
        getCollectionActivityUseCase,
    );
    const getTokenActivityAdapter = new GetTokenActivityHttpAdapter(
        getTokenActivityUseCase,
    );
    const getCollectionCustomizationAdapter =
        new GetCollectionCustomizationHttpAdapter(
            getCollectionCustomizationUseCase,
        );
    const getCollectionDetailAdapter = new GetCollectionDetailHttpAdapter(
        getCollectionDetailUseCase,
    );
    const getCollectionHoldersAdapter = new GetCollectionHoldersHttpAdapter(
        getCollectionHoldersUseCase,
    );
    const getTokenDetailAdapter = new GetTokenDetailHttpAdapter(
        getTokenDetailUseCase,
    );
    const getTokenPreviewAdapter = new GetTokenPreviewHttpAdapter(
        getTokenPreviewUseCase,
    );
    const updateCollectionCustomizationAdapter =
        new UpdateCollectionCustomizationHttpAdapter(
            updateCollectionCustomizationUseCase,
        );
    const getRuntimeHealthAdapter = new GetRuntimeHealthHttpAdapter(
        getRuntimeHealthUseCase,
    );
    const issueCsrfTokenHandler = createIssueCsrfTokenHandler(securityConfig);

    registerApiResponseHeaders(app, securityConfig);
    registerApiSecurityHooks(app, securityConfig);
    registerApiRoutes(
        app,
        commonHandlers,
        issueCsrfTokenHandler,
        createBootstrapRunAdapter,
        listBootstrapRunsAdapter,
        getBootstrapRunDetailAdapter,
        getBootstrapStatusAdapter,
        retryBootstrapRunFailedTasksAdapter,
        getDefaultChainAdapter,
        listCollectionsAdapter,
        resolveOwnerRefAdapter,
        getCollectionActivityAdapter,
        getTokenActivityAdapter,
        getCollectionCustomizationAdapter,
        getCollectionDetailAdapter,
        getCollectionHoldersAdapter,
        getTokenDetailAdapter,
        getTokenPreviewAdapter,
        updateCollectionCustomizationAdapter,
        getRuntimeHealthAdapter,
        {
            publicCollectionScope: deploymentConfig.publicCollectionScope,
            includeAdminRoutes:
                deploymentConfig.mode !== "public_single_collection",
            includeCsrfRoute:
                deploymentConfig.mode !== "public_single_collection",
        },
    );
    if (userlandUiDistDir) {
        registerUserlandStaticRoutes(app, userlandUiDistDir);
    }
    registerApiErrorHandlers(app);

    return app;
}
