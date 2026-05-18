import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
    RawReplyDefaultExpression,
    RawRequestDefaultExpression,
    RawServerDefault,
    RouteGenericInterface,
    RouteHandlerMethod,
} from "fastify";
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
    GetRuntimeConfigHttpAdapter,
    GetRuntimeConfigRoute,
} from "./http/handlers/config/get-runtime-config.js";
import type {
    GetActivityEventPreviewHttpAdapter,
    GetActivityEventPreviewRoute,
} from "./http/handlers/activities/get-activity-event-preview.js";
import { getActivityEventPreviewSpanAttributes } from "./http/handlers/activities/get-activity-event-preview.js";
import type {
    GetCollectionActivityHttpAdapter,
    GetCollectionActivityRoute,
} from "./http/handlers/activities/get-collection-activity.js";
import { getCollectionActivitySpanAttributes } from "./http/handlers/activities/get-collection-activity.js";
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
import { getCollectionDetailSpanAttributes } from "./http/handlers/collections/get-collection-detail.js";
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
    GetSyncBackfillStateHttpAdapter,
    GetSyncBackfillStateRoute,
} from "./http/handlers/sync-backfill/get-sync-backfill-state.js";
import type {
    ScheduleSyncBackfillHttpAdapter,
    ScheduleSyncBackfillRoute,
} from "./http/handlers/sync-backfill/schedule-sync-backfill.js";
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
import {
    getCollectionBiddingBidBookSpanAttributes,
} from "./http/handlers/trading/list-collection-bidding-bid-book.js";
import type {
    ListCollectionBiddingPriceTiersHttpAdapter,
    ListCollectionBiddingPriceTiersRoute,
} from "./http/handlers/trading/list-collection-bidding-price-tiers.js";
import type {
    GetTokenBiddingJobHttpAdapter,
    GetTokenBiddingJobRoute,
} from "./http/handlers/trading/get-token-bidding-job.js";
import type {
    GetTokenBiddingBidBookHttpAdapter,
    GetTokenBiddingBidBookRoute,
} from "./http/handlers/trading/get-token-bidding-bid-book.js";
import type {
    LookupBiddingJobTargetHttpAdapter,
    LookupBiddingJobTargetRoute,
} from "./http/handlers/trading/lookup-bidding-job-target.js";
import type {
    UpsertTokenBiddingJobHttpAdapter,
    UpsertTokenBiddingJobRoute,
} from "./http/handlers/trading/upsert-token-bidding-job.js";
import type {
    UpsertTraitBiddingJobHttpAdapter,
    UpsertTraitBiddingJobRoute,
} from "./http/handlers/trading/upsert-trait-bidding-job.js";
import type {
    UpsertBatchTokenBiddingJobsHttpAdapter,
    UpsertBatchTokenBiddingJobsRoute,
} from "./http/handlers/trading/upsert-batch-token-bidding-jobs.js";
import type {
    UpsertCollectionBiddingJobHttpAdapter,
    UpsertCollectionBiddingJobRoute,
} from "./http/handlers/trading/upsert-collection-bidding-job.js";
import type {
    UpsertCollectionBiddingPriceTierHttpAdapter,
    UpsertCollectionBiddingPriceTierRoute,
} from "./http/handlers/trading/upsert-collection-bidding-price-tier.js";
import type {
    UpdateCollectionBiddingSettingsHttpAdapter,
    UpdateCollectionBiddingSettingsRoute,
} from "./http/handlers/trading/update-collection-bidding-settings.js";
import type {
    PreviewBiddingPriceTierReapplyHttpAdapter,
    PreviewBiddingPriceTierReapplyRoute,
} from "./http/handlers/trading/preview-bidding-price-tier-reapply.js";
import type {
    ApplyBiddingPriceTierReapplyHttpAdapter,
    ApplyBiddingPriceTierReapplyRoute,
} from "./http/handlers/trading/apply-bidding-price-tier-reapply.js";
import type {
    ArchiveBiddingJobHttpAdapter,
    ArchiveBiddingJobRoute,
} from "./http/handlers/trading/archive-bidding-job.js";
import type {
    ArchiveTokenBiddingJobHttpAdapter,
    ArchiveTokenBiddingJobRoute,
} from "./http/handlers/trading/archive-token-bidding-job.js";
import type {
    ArchiveCollectionBiddingPriceTierHttpAdapter,
    ArchiveCollectionBiddingPriceTierRoute,
} from "./http/handlers/trading/archive-collection-bidding-price-tier.js";
import type { CommonHttpHandlers } from "./http/common/handlers.js";
import {
    observeRouteHandler,
    type BackendHttpObservability,
    type BackendRouteMetadata,
    type BackendRouteSpanAttributesResolver,
} from "./http/common/observability.js";

type PublicCollectionScope = {
    chainRef: string;
    collectionRef: string;
} | null;

type ApiRouteRegistrationOptions = {
    publicCollectionScope: PublicCollectionScope;
    includeAdminRoutes: boolean;
    includeCsrfRoute: boolean;
    observability: BackendHttpObservability;
};

type ApiRouteHandler<Route extends RouteGenericInterface> = (
    request: FastifyRequest<Route>,
    reply: FastifyReply,
) => Promise<unknown> | unknown;

type ApiRoutePreHandler<Route extends RouteGenericInterface> = (
    request: FastifyRequest<Route>,
    reply: FastifyReply,
) => Promise<void> | void;

type ObservedRouteSettings<Route extends RouteGenericInterface> = {
    preHandler?: ApiRoutePreHandler<Route>;
    spanAttributes?: BackendRouteSpanAttributesResolver<Route>;
};

type ObservedRouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";

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
    getRuntimeConfigAdapter: GetRuntimeConfigHttpAdapter,
    listCollectionsAdapter: ListCollectionsHttpAdapter,
    getSyncBackfillStateAdapter: GetSyncBackfillStateHttpAdapter,
    scheduleSyncBackfillAdapter: ScheduleSyncBackfillHttpAdapter,
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
    listCollectionBiddingPriceTiersAdapter: ListCollectionBiddingPriceTiersHttpAdapter,
    getTokenBiddingJobAdapter: GetTokenBiddingJobHttpAdapter,
    getTokenBiddingBidBookAdapter: GetTokenBiddingBidBookHttpAdapter,
    lookupBiddingJobTargetAdapter: LookupBiddingJobTargetHttpAdapter,
    upsertTokenBiddingJobAdapter: UpsertTokenBiddingJobHttpAdapter,
    upsertTraitBiddingJobAdapter: UpsertTraitBiddingJobHttpAdapter,
    upsertBatchTokenBiddingJobsAdapter: UpsertBatchTokenBiddingJobsHttpAdapter,
    upsertCollectionBiddingJobAdapter: UpsertCollectionBiddingJobHttpAdapter,
    upsertCollectionBiddingPriceTierAdapter: UpsertCollectionBiddingPriceTierHttpAdapter,
    updateCollectionBiddingSettingsAdapter: UpdateCollectionBiddingSettingsHttpAdapter,
    previewBiddingPriceTierReapplyAdapter: PreviewBiddingPriceTierReapplyHttpAdapter,
    applyBiddingPriceTierReapplyAdapter: ApplyBiddingPriceTierReapplyHttpAdapter,
    archiveBiddingJobAdapter: ArchiveBiddingJobHttpAdapter,
    archiveTokenBiddingJobAdapter: ArchiveTokenBiddingJobHttpAdapter,
    archiveCollectionBiddingPriceTierAdapter: ArchiveCollectionBiddingPriceTierHttpAdapter,
    getRuntimeHealthAdapter: GetRuntimeHealthHttpAdapter,
    options: ApiRouteRegistrationOptions,
): void {
    const publicCollectionScopeGuard = createPublicCollectionScopeGuard(
        options.publicCollectionScope,
    );
    const publicChainScopeGuard = createPublicChainScopeGuard(
        options.publicCollectionScope,
    );

    registerObservedGet(app, options, "/health", async () => ({
        status: "ok",
    }));
    registerObservedGet<GetRuntimeHealthRoute>(
        app,
        options,
        "/health/runtime",
        getRuntimeHealthAdapter.handle,
    );
    registerObservedOptions(app, options, "/api/*", commonHandlers.optionsApi);
    registerObservedGet<GetDefaultChainRoute>(
        app,
        options,
        "/api/chains/default",
        getDefaultChainAdapter.handle,
    );
    registerObservedGet<GetRuntimeConfigRoute>(
        app,
        options,
        "/api/runtime/config",
        getRuntimeConfigAdapter.handle,
    );
    registerObservedGet<ResolveOwnerRefRoute>(
        app,
        options,
        "/api/:chain_ref/resolve-owner-ref",
        resolveOwnerRefAdapter.handle,
        {
            preHandler: publicChainScopeGuard,
        },
    );
    registerObservedGet<GetCollectionActivityRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/activity",
        getCollectionActivityAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
            spanAttributes: getCollectionActivitySpanAttributes,
        },
    );
    registerObservedGet<GetActivityEventPreviewRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/activity/:activity_id/preview",
        getActivityEventPreviewAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
            spanAttributes: getActivityEventPreviewSpanAttributes,
        },
    );
    registerObservedGet<GetCollectionDetailRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref",
        getCollectionDetailAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
            spanAttributes: getCollectionDetailSpanAttributes,
        },
    );
    registerObservedGet<GetCollectionHoldersRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/holders",
        getCollectionHoldersAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
        },
    );
    registerObservedGet<GetTokenActivityRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/activity",
        getTokenActivityAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
        },
    );
    registerObservedGet<ListCollectionBiddingBidBookRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/bids",
        listCollectionBiddingBidBookAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
            spanAttributes: getCollectionBiddingBidBookSpanAttributes,
        },
    );
    registerObservedGet<GetTokenPreviewRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/preview",
        getTokenPreviewAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
        },
    );
    registerObservedGet<GetTokenUriRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/token-uri",
        getTokenUriAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
        },
    );
    registerObservedGet<GetTokenBiddingBidBookRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/bids",
        getTokenBiddingBidBookAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
        },
    );
    registerObservedGet<GetTokenDetailRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref",
        getTokenDetailAdapter.handle,
        {
            preHandler: publicCollectionScopeGuard,
        },
    );
    if (options.includeCsrfRoute) {
        registerObservedGet(
            app,
            options,
            "/api/security/csrf",
            issueCsrfTokenHandler,
        );
    }

    if (!options.includeAdminRoutes) {
        return;
    }

    registerObservedGet<ListCollectionsRoute>(
        app,
        options,
        "/api/:chain_ref/collections",
        listCollectionsAdapter.handle,
    );
    registerObservedGet<GetSyncBackfillStateRoute>(
        app,
        options,
        "/api/:chain_ref/sync-backfill",
        getSyncBackfillStateAdapter.handle,
    );
    registerObservedPost<ScheduleSyncBackfillRoute>(
        app,
        options,
        "/api/:chain_ref/sync-backfill/backfill",
        scheduleSyncBackfillAdapter.handle,
    );
    registerObservedGet<GetCollectionCustomizationRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/customization",
        getCollectionCustomizationAdapter.handle,
    );
    registerObservedGet<ListCollectionBiddingJobsRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/jobs",
        listCollectionBiddingJobsAdapter.handle,
    );
    registerObservedGet<ListCollectionBiddingPriceTiersRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/price-tiers",
        listCollectionBiddingPriceTiersAdapter.handle,
    );
    registerObservedGet<PreviewBiddingPriceTierReapplyRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id/reapply-preview",
        previewBiddingPriceTierReapplyAdapter.handle,
    );
    registerObservedGet<GetTokenBiddingJobRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
        getTokenBiddingJobAdapter.handle,
    );
    registerObservedPost<LookupBiddingJobTargetRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/jobs/target-lookup",
        lookupBiddingJobTargetAdapter.handle,
    );
    registerObservedPost<CreateBootstrapRunRoute>(
        app,
        options,
        "/api/:chain_ref/collections/bootstrap",
        createBootstrapRunAdapter.handle,
    );
    registerObservedGet<ListBootstrapRunsRoute>(
        app,
        options,
        "/api/:chain_ref/bootstrap-runs",
        listBootstrapRunsAdapter.handle,
    );
    registerObservedGet<GetBootstrapRunDetailRoute>(
        app,
        options,
        "/api/:chain_ref/bootstrap-runs/:run_id",
        getBootstrapRunDetailAdapter.handle,
    );
    registerObservedGet<GetBootstrapStatusRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bootstrap",
        getBootstrapStatusAdapter.handle,
    );
    registerObservedPut<UpdateCollectionCustomizationRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/customization",
        updateCollectionCustomizationAdapter.handle,
    );
    registerObservedPut<UpsertTokenBiddingJobRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
        upsertTokenBiddingJobAdapter.handle,
    );
    registerObservedPut<UpsertTraitBiddingJobRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/jobs/traits",
        upsertTraitBiddingJobAdapter.handle,
    );
    registerObservedPut<UpsertBatchTokenBiddingJobsRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/jobs/tokens/batch",
        upsertBatchTokenBiddingJobsAdapter.handle,
    );
    registerObservedPut<UpsertCollectionBiddingJobRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/jobs/collection",
        upsertCollectionBiddingJobAdapter.handle,
    );
    registerObservedPut<UpsertCollectionBiddingPriceTierRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/price-tiers",
        upsertCollectionBiddingPriceTierAdapter.handle,
    );
    registerObservedPut<UpdateCollectionBiddingSettingsRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/settings",
        updateCollectionBiddingSettingsAdapter.handle,
    );
    registerObservedPost<ApplyBiddingPriceTierReapplyRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id/reapply",
        applyBiddingPriceTierReapplyAdapter.handle,
    );
    registerObservedDelete<ArchiveTokenBiddingJobRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
        archiveTokenBiddingJobAdapter.handle,
    );
    registerObservedDelete<ArchiveBiddingJobRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/jobs/:job_id",
        archiveBiddingJobAdapter.handle,
    );
    registerObservedDelete<ArchiveCollectionBiddingPriceTierRoute>(
        app,
        options,
        "/api/:chain_ref/:collection_ref/bidding/price-tiers/:tier_id",
        archiveCollectionBiddingPriceTierAdapter.handle,
    );
    registerObservedPost<RetryBootstrapRunFailedTasksRoute>(
        app,
        options,
        "/api/:chain_ref/bootstrap-runs/:run_id/retry-failed",
        retryBootstrapRunFailedTasksAdapter.handle,
    );
}

function registerObservedGet<
    Route extends RouteGenericInterface = RouteGenericInterface,
>(
    app: FastifyInstance,
    options: ApiRouteRegistrationOptions,
    route: string,
    handler: ApiRouteHandler<Route>,
    settings: ObservedRouteSettings<Route> = {},
): void {
    registerObservedRoute(app, options, "GET", route, handler, settings);
}

function registerObservedPost<Route extends RouteGenericInterface>(
    app: FastifyInstance,
    options: ApiRouteRegistrationOptions,
    route: string,
    handler: ApiRouteHandler<Route>,
): void {
    registerObservedRoute(app, options, "POST", route, handler);
}

function registerObservedPut<Route extends RouteGenericInterface>(
    app: FastifyInstance,
    options: ApiRouteRegistrationOptions,
    route: string,
    handler: ApiRouteHandler<Route>,
): void {
    registerObservedRoute(app, options, "PUT", route, handler);
}

function registerObservedDelete<Route extends RouteGenericInterface>(
    app: FastifyInstance,
    options: ApiRouteRegistrationOptions,
    route: string,
    handler: ApiRouteHandler<Route>,
): void {
    registerObservedRoute(app, options, "DELETE", route, handler);
}

function registerObservedOptions(
    app: FastifyInstance,
    options: ApiRouteRegistrationOptions,
    route: string,
    handler: ApiRouteHandler<RouteGenericInterface>,
): void {
    registerObservedRoute(app, options, "OPTIONS", route, handler);
}

function registerObservedRoute<Route extends RouteGenericInterface>(
    app: FastifyInstance,
    options: ApiRouteRegistrationOptions,
    method: ObservedRouteMethod,
    route: string,
    handler: ApiRouteHandler<Route>,
    settings: ObservedRouteSettings<Route> = {},
): void {
    const metadata = {
        method,
        route,
        spanAttributes: settings.spanAttributes,
    } satisfies BackendRouteMetadata<Route>;
    const observedHandler = observeRouteHandler(
        options.observability,
        metadata,
        handler,
    ) as RouteHandlerMethod<
        RawServerDefault,
        RawRequestDefaultExpression<RawServerDefault>,
        RawReplyDefaultExpression<RawServerDefault>,
        Route
    >;
    const routeSettings =
        settings.preHandler === undefined
            ? {}
            : {
                  preHandler: settings.preHandler,
              };

    if (method === "GET") {
        app.get<Route>(route, routeSettings, observedHandler);
        return;
    }
    if (method === "POST") {
        app.post<Route>(route, routeSettings, observedHandler);
        return;
    }
    if (method === "PUT") {
        app.put<Route>(route, routeSettings, observedHandler);
        return;
    }
    if (method === "DELETE") {
        app.delete<Route>(route, routeSettings, observedHandler);
        return;
    }
    app.options<Route>(route, routeSettings, observedHandler);
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
