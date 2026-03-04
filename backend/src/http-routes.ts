import type { FastifyInstance } from "fastify";
import type {
    CreateBootstrapRunHttpAdapter,
    CreateBootstrapRunRoute,
} from "./http/handlers/bootstrap/create-bootstrap-run.js";
import type {
    GetBootstrapStatusHttpAdapter,
    GetBootstrapStatusRoute,
} from "./http/handlers/bootstrap/get-bootstrap-status.js";
import type {
    ListBootstrapMetadataTasksHttpAdapter,
    ListBootstrapMetadataTasksRoute,
} from "./http/handlers/bootstrap/list-bootstrap-metadata-tasks.js";
import type {
    RestartBootstrapRunHttpAdapter,
    RestartBootstrapRunRoute,
} from "./http/handlers/bootstrap/restart-bootstrap-run.js";
import type {
    RetryBootstrapFailedTasksHttpAdapter,
    RetryBootstrapFailedTasksRoute,
} from "./http/handlers/bootstrap/retry-bootstrap-failed-tasks.js";
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
import type {
    GetRuntimeHealthHttpAdapter,
    GetRuntimeHealthRoute,
} from "./http/handlers/health/get-runtime-health.js";
import type { CommonHttpHandlers } from "./http/common/handlers.js";
import { issueCsrfToken } from "./http/common/security.js";

export function registerApiRoutes(
    app: FastifyInstance,
    commonHandlers: CommonHttpHandlers,
    createBootstrapRunAdapter: CreateBootstrapRunHttpAdapter,
    getBootstrapStatusAdapter: GetBootstrapStatusHttpAdapter,
    listBootstrapMetadataTasksAdapter: ListBootstrapMetadataTasksHttpAdapter,
    retryBootstrapFailedTasksAdapter: RetryBootstrapFailedTasksHttpAdapter,
    restartBootstrapRunAdapter: RestartBootstrapRunHttpAdapter,
    getDefaultChainAdapter: GetDefaultChainHttpAdapter,
    listCollectionsAdapter: ListCollectionsHttpAdapter,
    getCollectionDetailAdapter: GetCollectionDetailHttpAdapter,
    getRuntimeHealthAdapter: GetRuntimeHealthHttpAdapter,
): void {
    app.get("/health", async () => ({ status: "ok" }));
    app.get<GetRuntimeHealthRoute>(
        "/health/runtime",
        getRuntimeHealthAdapter.handle,
    );
    app.options("/api/*", commonHandlers.optionsApi);
    app.get("/api/security/csrf", issueCsrfToken);
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
    app.post<CreateBootstrapRunRoute>(
        "/api/:chain_ref/collections/bootstrap",
        createBootstrapRunAdapter.handle,
    );
    app.get<GetBootstrapStatusRoute>(
        "/api/:chain_ref/:collection_ref/bootstrap",
        getBootstrapStatusAdapter.handle,
    );
    app.get<ListBootstrapMetadataTasksRoute>(
        "/api/:chain_ref/:collection_ref/bootstrap/metadata-tasks",
        listBootstrapMetadataTasksAdapter.handle,
    );
    app.post<RetryBootstrapFailedTasksRoute>(
        "/api/:chain_ref/:collection_ref/bootstrap/retry-failed",
        retryBootstrapFailedTasksAdapter.handle,
    );
    app.post<RestartBootstrapRunRoute>(
        "/api/:chain_ref/:collection_ref/bootstrap/restart",
        restartBootstrapRunAdapter.handle,
    );
}
