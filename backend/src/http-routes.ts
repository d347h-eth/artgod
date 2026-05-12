import type { FastifyInstance } from "fastify";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
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
    GetActivityEventPreviewHttpAdapter,
    GetActivityEventPreviewRoute,
} from "./http/handlers/activities/get-activity-event-preview.js";
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
    GetTokenPreviewHttpAdapter,
    GetTokenPreviewRoute,
} from "./http/handlers/collections/get-token-preview.js";
import type {
    GetTokenUriHttpAdapter,
    GetTokenUriRoute,
} from "./http/handlers/collections/get-token-uri.js";
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
import type {
    ResolveOwnerRefHttpAdapter,
    ResolveOwnerRefRoute,
} from "./http/handlers/owners/resolve-owner-ref.js";
import type {
    ListCollectionBiddingJobsHttpAdapter,
    ListCollectionBiddingJobsRoute,
} from "./http/handlers/trading/list-collection-bidding-jobs.js";
import type {
    ListCollectionBiddingBidBookHttpAdapter,
    ListCollectionBiddingBidBookRoute,
} from "./http/handlers/trading/list-collection-bidding-bid-book.js";
import type {
    GetTokenBiddingJobHttpAdapter,
    GetTokenBiddingJobRoute,
} from "./http/handlers/trading/get-token-bidding-job.js";
import type {
    GetTokenBiddingBidBookHttpAdapter,
    GetTokenBiddingBidBookRoute,
} from "./http/handlers/trading/get-token-bidding-bid-book.js";
import type {
    UpsertTokenBiddingJobHttpAdapter,
    UpsertTokenBiddingJobRoute,
} from "./http/handlers/trading/upsert-token-bidding-job.js";
import type {
    UpsertTraitBiddingJobHttpAdapter,
    UpsertTraitBiddingJobRoute,
} from "./http/handlers/trading/upsert-trait-bidding-job.js";
import type {
    ArchiveTokenBiddingJobHttpAdapter,
    ArchiveTokenBiddingJobRoute,
} from "./http/handlers/trading/archive-token-bidding-job.js";
import type { CommonHttpHandlers } from "./http/common/handlers.js";
import type { FastifyReply, FastifyRequest } from "fastify";

type PublicCollectionScope = {
    chainRef: string;
    collectionRef: string;
} | null;

type ApiRouteRegistrationOptions = {
    publicCollectionScope: PublicCollectionScope;
    includeAdminRoutes: boolean;
    includeCsrfRoute: boolean;
};

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
    resolveOwnerRefAdapter: ResolveOwnerRefHttpAdapter,
    getCollectionActivityAdapter: GetCollectionActivityHttpAdapter,
    getActivityEventPreviewAdapter: GetActivityEventPreviewHttpAdapter,
    getTokenActivityAdapter: GetTokenActivityHttpAdapter,
    getCollectionCustomizationAdapter: GetCollectionCustomizationHttpAdapter,
    getCollectionDetailAdapter: GetCollectionDetailHttpAdapter,
    getCollectionHoldersAdapter: GetCollectionHoldersHttpAdapter,
    getTokenDetailAdapter: GetTokenDetailHttpAdapter,
    getTokenPreviewAdapter: GetTokenPreviewHttpAdapter,
    getTokenUriAdapter: GetTokenUriHttpAdapter,
    updateCollectionCustomizationAdapter: UpdateCollectionCustomizationHttpAdapter,
    listCollectionBiddingJobsAdapter: ListCollectionBiddingJobsHttpAdapter,
    listCollectionBiddingBidBookAdapter: ListCollectionBiddingBidBookHttpAdapter,
    getTokenBiddingJobAdapter: GetTokenBiddingJobHttpAdapter,
    getTokenBiddingBidBookAdapter: GetTokenBiddingBidBookHttpAdapter,
    upsertTokenBiddingJobAdapter: UpsertTokenBiddingJobHttpAdapter,
    upsertTraitBiddingJobAdapter: UpsertTraitBiddingJobHttpAdapter,
    archiveTokenBiddingJobAdapter: ArchiveTokenBiddingJobHttpAdapter,
    getRuntimeHealthAdapter: GetRuntimeHealthHttpAdapter,
    options: ApiRouteRegistrationOptions,
): void {
    const publicCollectionScopeGuard = createPublicCollectionScopeGuard(
        options.publicCollectionScope,
    );
    const publicChainScopeGuard = createPublicChainScopeGuard(
        options.publicCollectionScope,
    );

    app.get("/health", async () => ({ status: "ok" }));
    app.get<GetRuntimeHealthRoute>(
        "/health/runtime",
        getRuntimeHealthAdapter.handle,
    );
    app.options("/api/*", commonHandlers.optionsApi);
    app.get<GetDefaultChainRoute>(
        "/api/chains/default",
        getDefaultChainAdapter.handle,
    );
    app.get<ResolveOwnerRefRoute>(
        "/api/:chain_ref/resolve-owner-ref",
        {
            preHandler: publicChainScopeGuard,
        },
        resolveOwnerRefAdapter.handle,
    );
    app.get<GetCollectionActivityRoute>(
        "/api/:chain_ref/:collection_ref/activity",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getCollectionActivityAdapter.handle,
    );
    app.get<GetActivityEventPreviewRoute>(
        "/api/:chain_ref/:collection_ref/activity/:activity_id/preview",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getActivityEventPreviewAdapter.handle,
    );
    app.get<GetCollectionDetailRoute>(
        "/api/:chain_ref/:collection_ref",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getCollectionDetailAdapter.handle,
    );
    app.get<GetCollectionHoldersRoute>(
        "/api/:chain_ref/:collection_ref/holders",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getCollectionHoldersAdapter.handle,
    );
    app.get<GetTokenActivityRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/activity",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getTokenActivityAdapter.handle,
    );
    app.get<ListCollectionBiddingBidBookRoute>(
        "/api/:chain_ref/:collection_ref/bidding/bids",
        {
            preHandler: publicCollectionScopeGuard,
        },
        listCollectionBiddingBidBookAdapter.handle,
    );
    app.get<GetTokenPreviewRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/preview",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getTokenPreviewAdapter.handle,
    );
    app.get<GetTokenUriRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/token-uri",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getTokenUriAdapter.handle,
    );
    app.get<GetTokenBiddingBidBookRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/bids",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getTokenBiddingBidBookAdapter.handle,
    );
    app.get<GetTokenDetailRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref",
        {
            preHandler: publicCollectionScopeGuard,
        },
        getTokenDetailAdapter.handle,
    );
    if (options.includeCsrfRoute) {
        app.get("/api/security/csrf", issueCsrfTokenHandler);
    }

    if (!options.includeAdminRoutes) {
        return;
    }

    app.get<ListCollectionsRoute>(
        "/api/:chain_ref/collections",
        listCollectionsAdapter.handle,
    );
    app.get<GetCollectionCustomizationRoute>(
        "/api/:chain_ref/:collection_ref/customization",
        getCollectionCustomizationAdapter.handle,
    );
    app.get<ListCollectionBiddingJobsRoute>(
        "/api/:chain_ref/:collection_ref/bidding/jobs",
        listCollectionBiddingJobsAdapter.handle,
    );
    app.get<GetTokenBiddingJobRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
        getTokenBiddingJobAdapter.handle,
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
    app.put<UpdateCollectionCustomizationRoute>(
        "/api/:chain_ref/:collection_ref/customization",
        updateCollectionCustomizationAdapter.handle,
    );
    app.put<UpsertTokenBiddingJobRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
        upsertTokenBiddingJobAdapter.handle,
    );
    app.put<UpsertTraitBiddingJobRoute>(
        "/api/:chain_ref/:collection_ref/bidding/jobs/traits",
        upsertTraitBiddingJobAdapter.handle,
    );
    app.delete<ArchiveTokenBiddingJobRoute>(
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
        archiveTokenBiddingJobAdapter.handle,
    );
    app.post<RetryBootstrapRunFailedTasksRoute>(
        "/api/:chain_ref/bootstrap-runs/:run_id/retry-failed",
        retryBootstrapRunFailedTasksAdapter.handle,
    );
}

function createPublicChainScopeGuard(scope: PublicCollectionScope) {
    if (!scope) {
        return undefined;
    }

    return async function publicChainScopeGuard(
        request: FastifyRequest,
        reply: FastifyReply,
    ): Promise<void> {
        const params = request.params as { chain_ref?: string } | undefined;
        if (!params?.chain_ref) {
            return;
        }

        if (normalizeSlugRef(params.chain_ref) !== scope.chainRef) {
            await reply.callNotFound();
        }
    };
}

function createPublicCollectionScopeGuard(scope: PublicCollectionScope) {
    if (!scope) {
        return undefined;
    }

    return async function publicCollectionScopeGuard(
        request: FastifyRequest,
        reply: FastifyReply,
    ): Promise<void> {
        const params = request.params as
            | { chain_ref?: string; collection_ref?: string }
            | undefined;
        if (!params?.chain_ref || !params.collection_ref) {
            return;
        }

        if (
            normalizeSlugRef(params.chain_ref) !== scope.chainRef ||
            normalizeSlugRef(params.collection_ref) !== scope.collectionRef
        ) {
            await reply.callNotFound();
        }
    };
}
