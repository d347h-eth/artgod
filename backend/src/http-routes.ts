import type { FastifyInstance } from "fastify";
import type {
    CreateBootstrapRunHttpAdapter,
    CreateBootstrapRunRoute,
} from "./http/handlers/bootstrap/create-bootstrap-run.js";
import type {
    GetBootstrapRunDetailHttpAdapter,
    GetBootstrapRunDetailRoute,
} from "./http/handlers/bootstrap/get-bootstrap-run-detail.js";
import type {
    GetBootstrapStatusHttpAdapter,
    GetBootstrapStatusRoute,
} from "./http/handlers/bootstrap/get-bootstrap-status.js";
import type {
    ListBootstrapRunsHttpAdapter,
    ListBootstrapRunsRoute,
} from "./http/handlers/bootstrap/list-bootstrap-runs.js";
import type {
    RetryBootstrapRunFailedTasksHttpAdapter,
    RetryBootstrapRunFailedTasksRoute,
} from "./http/handlers/bootstrap/retry-bootstrap-run-failed-tasks.js";
import type { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import type { GetDefaultChainRoute } from "./http/handlers/chains/get-default-chain.js";
import type {
    GetCollectionActivityHttpAdapter,
    GetCollectionActivityRoute,
} from "./http/handlers/activities/get-collection-activity.js";
import type {
    GetTokenActivityHttpAdapter,
    GetTokenActivityRoute,
} from "./http/handlers/activities/get-token-activity.js";
import type {
    GetCollectionCustomizationHttpAdapter,
    GetCollectionCustomizationRoute,
} from "./http/handlers/collections/get-collection-customization.js";
import type {
    GetCollectionDetailHttpAdapter,
    GetCollectionDetailRoute,
} from "./http/handlers/collections/get-collection-detail.js";
import type {
    GetCollectionHoldersHttpAdapter,
    GetCollectionHoldersRoute,
} from "./http/handlers/collections/get-collection-holders.js";
import type {
    GetTokenDetailHttpAdapter,
    GetTokenDetailRoute,
} from "./http/handlers/collections/get-token-detail.js";
import type {
    UpdateCollectionCustomizationHttpAdapter,
    UpdateCollectionCustomizationRoute,
} from "./http/handlers/collections/update-collection-customization.js";
import type {
    ListCollectionsHttpAdapter,
    ListCollectionsRoute,
} from "./http/handlers/collections/list-collections.js";
import type {
    GetRuntimeHealthHttpAdapter,
    GetRuntimeHealthRoute,
} from "./http/handlers/health/get-runtime-health.js";
import type { CommonHttpHandlers } from "./http/common/handlers.js";
import type { FastifyReply, FastifyRequest } from "fastify";

export function registerApiRoutes(
    app: FastifyInstance,
    commonHandlers: CommonHttpHandlers,
    issueCsrfTokenHandler: (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => Promise<{ token: string }>,
    createBootstrapRunAdapter: CreateBootstrapRunHttpAdapter,
    listBootstrapRunsAdapter: ListBootstrapRunsHttpAdapter,
    getBootstrapRunDetailAdapter: GetBootstrapRunDetailHttpAdapter,
    getBootstrapStatusAdapter: GetBootstrapStatusHttpAdapter,
    retryBootstrapRunFailedTasksAdapter: RetryBootstrapRunFailedTasksHttpAdapter,
    getDefaultChainAdapter: GetDefaultChainHttpAdapter,
    listCollectionsAdapter: ListCollectionsHttpAdapter,
    getCollectionActivityAdapter: GetCollectionActivityHttpAdapter,
    getTokenActivityAdapter: GetTokenActivityHttpAdapter,
    getCollectionCustomizationAdapter: GetCollectionCustomizationHttpAdapter,
    getCollectionDetailAdapter: GetCollectionDetailHttpAdapter,
    getCollectionHoldersAdapter: GetCollectionHoldersHttpAdapter,
    getTokenDetailAdapter: GetTokenDetailHttpAdapter,
    updateCollectionCustomizationAdapter: UpdateCollectionCustomizationHttpAdapter,
    getRuntimeHealthAdapter: GetRuntimeHealthHttpAdapter,
): void {
    app.get("/health", async () => ({ status: "ok" }));
    app.get<GetRuntimeHealthRoute>(
        "/health/runtime",
        getRuntimeHealthAdapter.handle,
    );
    app.options("/api/*", commonHandlers.optionsApi);
    app.get("/api/security/csrf", issueCsrfTokenHandler);
    app.get<GetDefaultChainRoute>(
        "/api/chains/default",
        getDefaultChainAdapter.handle,
    );
    app.get<ListCollectionsRoute>(
        "/api/:chain_ref/collections",
        listCollectionsAdapter.handle,
    );
    app.get<GetCollectionActivityRoute>(
        "/api/:chain_ref/:collection_ref/activity",
        getCollectionActivityAdapter.handle,
    );
    app.get<GetCollectionDetailRoute>(
        "/api/:chain_ref/:collection_ref",
        getCollectionDetailAdapter.handle,
    );
    app.get<GetCollectionCustomizationRoute>(
        "/api/:chain_ref/:collection_ref/customization",
        getCollectionCustomizationAdapter.handle,
    );
    app.get<GetCollectionHoldersRoute>(
        "/api/:chain_ref/:collection_ref/holders",
        getCollectionHoldersAdapter.handle,
    );
    app.post<CreateBootstrapRunRoute>(
        "/api/:chain_ref/collections/bootstrap",
        createBootstrapRunAdapter.handle,
    );
    app.get<ListBootstrapRunsRoute>(
        "/api/:chain_ref/bootstrap-runs",
        listBootstrapRunsAdapter.handle,
    );
    app.get<GetBootstrapRunDetailRoute>(
        "/api/:chain_ref/bootstrap-runs/:run_id",
        getBootstrapRunDetailAdapter.handle,
    );
    app.get<GetBootstrapStatusRoute>(
        "/api/:chain_ref/:collection_ref/bootstrap",
        getBootstrapStatusAdapter.handle,
    );
    app.get<GetTokenActivityRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/activity",
        getTokenActivityAdapter.handle,
    );
    app.get<GetTokenDetailRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref",
        getTokenDetailAdapter.handle,
    );
    app.put<UpdateCollectionCustomizationRoute>(
        "/api/:chain_ref/:collection_ref/customization",
        updateCollectionCustomizationAdapter.handle,
    );
    app.post<RetryBootstrapRunFailedTasksRoute>(
        "/api/:chain_ref/bootstrap-runs/:run_id/retry-failed",
        retryBootstrapRunFailedTasksAdapter.handle,
    );
}
