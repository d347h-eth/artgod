import Fastify, { type FastifyInstance } from "fastify";
import type { CreateBootstrapRunUseCase } from "./application/use-cases/bootstrap/create-bootstrap-run.js";
import type { ApplyBootstrapRunStepActionUseCase } from "./application/use-cases/bootstrap/apply-bootstrap-run-step-action.js";
import type { GetBootstrapRunDetailUseCase } from "./application/use-cases/bootstrap/get-bootstrap-run-detail.js";
import type { GetBootstrapStatusUseCase } from "./application/use-cases/bootstrap/get-bootstrap-status.js";
import type { ListBootstrapRunsUseCase } from "./application/use-cases/bootstrap/list-bootstrap-runs.js";
import type { ProbeCollectionContractUseCase } from "./application/use-cases/bootstrap/probe-collection-contract.js";
import type { RetryBootstrapRunFailedTasksUseCase } from "./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";
import type { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import type { GetRuntimeConfigUseCase } from "./application/use-cases/config/get-runtime-config.js";
import type { GetCollectionActivityUseCase } from "./application/use-cases/activities/get-collection-activity.js";
import type { GetActivityEventPreviewUseCase } from "./application/use-cases/activities/get-activity-event-preview.js";
import type { GetTokenActivityUseCase } from "./application/use-cases/activities/get-token-activity.js";
import type { GetCollectionCustomizationUseCase } from "./application/use-cases/collections/get-collection-customization.js";
import type { GetCollectionDetailPort } from "./application/use-cases/collections/get-collection-detail.js";
import type { GetCollectionHoldersUseCase } from "./application/use-cases/collections/get-collection-holders.js";
import type { GetCollectionTraitCatalogPort } from "./application/use-cases/collections/get-collection-trait-catalog.js";
import type { GetTokenDetailUseCase } from "./application/use-cases/collections/get-token-detail.js";
import type { GetTokenPreviewPort } from "./application/use-cases/collections/get-token-preview.js";
import type { GetTokenUriUseCase } from "./application/use-cases/collections/get-token-uri.js";
import type { PurgeCollectionUseCase } from "./application/use-cases/collections/purge-collection.js";
import type { UpdateCollectionCustomizationUseCase } from "./application/use-cases/collections/update-collection-customization.js";
import type { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import type {
    GetSyncBackfillRangeSummaryInput,
    GetSyncBackfillRangeSummaryOutput,
    GetSyncBackfillStateInput,
    GetSyncBackfillStateOutput,
} from "./application/use-cases/sync-backfill/get-sync-backfill-state.js";
import type {
    ScheduleSyncBackfillInput,
    ScheduleSyncBackfillOutput,
} from "./application/use-cases/sync-backfill/schedule-sync-backfill.js";
import type { GetRuntimeHealthUseCase } from "./application/use-cases/health/get-runtime-health.js";
import type { ResolveOwnerRefUseCase } from "./application/use-cases/owners/resolve-owner-ref.js";
import type { ListCollectionBiddingBidBookUseCase } from "./application/use-cases/trading/list-collection-bidding-bid-book.js";
import type { ListCollectionBiddingPriceTiersUseCase } from "./application/use-cases/trading/list-collection-bidding-price-tiers.js";
import type { GetTokenBiddingJobUseCase } from "./application/use-cases/trading/get-token-bidding-job.js";
import type { GetTokenBiddingBidBookUseCase } from "./application/use-cases/trading/get-token-bidding-bid-book.js";
import type { BiddingJobTargetLookupUseCase } from "./application/use-cases/trading/bidding-job-target-lookup.js";
import type { UpsertTokenBiddingJobUseCase } from "./application/use-cases/trading/upsert-token-bidding-job.js";
import type { UpsertTraitBiddingJobUseCase } from "./application/use-cases/trading/upsert-trait-bidding-job.js";
import type { UpsertBatchTokenBiddingJobsUseCase } from "./application/use-cases/trading/upsert-batch-token-bidding-jobs.js";
import type { UpsertCollectionBiddingJobUseCase } from "./application/use-cases/trading/upsert-collection-bidding-job.js";
import type { UpsertCollectionBiddingPriceTierUseCase } from "./application/use-cases/trading/upsert-collection-bidding-price-tier.js";
import type { UpdateCollectionBiddingSettingsUseCase } from "./application/use-cases/trading/update-collection-bidding-settings.js";
import type { PreviewBiddingPriceTierReapplyUseCase } from "./application/use-cases/trading/preview-bidding-price-tier-reapply.js";
import type { ApplyBiddingPriceTierReapplyUseCase } from "./application/use-cases/trading/apply-bidding-price-tier-reapply.js";
import type { ArchiveBiddingJobUseCase } from "./application/use-cases/trading/archive-bidding-job.js";
import type { ArchiveTokenBiddingJobUseCase } from "./application/use-cases/trading/archive-token-bidding-job.js";
import type { ArchiveCollectionBiddingPriceTierUseCase } from "./application/use-cases/trading/archive-collection-bidding-price-tier.js";
import { CreateBootstrapRunHttpAdapter } from "./http/handlers/bootstrap/create-bootstrap-run.js";
import { ApplyBootstrapRunStepActionHttpAdapter } from "./http/handlers/bootstrap/apply-bootstrap-run-step-action.js";
import { GetBootstrapRunDetailHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-run-detail.js";
import { GetBootstrapStatusHttpAdapter } from "./http/handlers/bootstrap/get-bootstrap-status.js";
import { ListBootstrapRunsHttpAdapter } from "./http/handlers/bootstrap/list-bootstrap-runs.js";
import { ProbeCollectionContractHttpAdapter } from "./http/handlers/bootstrap/probe-collection-contract.js";
import { RetryBootstrapRunFailedTasksHttpAdapter } from "./http/handlers/bootstrap/retry-bootstrap-run-failed-tasks.js";
import { GetDefaultChainHttpAdapter } from "./http/handlers/chains/get-default-chain.js";
import { GetRuntimeConfigHttpAdapter } from "./http/handlers/config/get-runtime-config.js";
import { GetCollectionActivityHttpAdapter } from "./http/handlers/activities/get-collection-activity.js";
import { GetActivityEventPreviewHttpAdapter } from "./http/handlers/activities/get-activity-event-preview.js";
import { GetTokenActivityHttpAdapter } from "./http/handlers/activities/get-token-activity.js";
import { GetCollectionCustomizationHttpAdapter } from "./http/handlers/collections/get-collection-customization.js";
import { GetCollectionDetailHttpAdapter } from "./http/handlers/collections/get-collection-detail.js";
import { GetCollectionHoldersHttpAdapter } from "./http/handlers/collections/get-collection-holders.js";
import { GetCollectionTraitCatalogHttpAdapter } from "./http/handlers/collections/get-collection-trait-catalog.js";
import { GetTokenDetailHttpAdapter } from "./http/handlers/collections/get-token-detail.js";
import { GetTokenPreviewHttpAdapter } from "./http/handlers/collections/get-token-preview.js";
import { GetTokenUriHttpAdapter } from "./http/handlers/collections/get-token-uri.js";
import { PurgeCollectionHttpAdapter } from "./http/handlers/collections/purge-collection.js";
import { UpdateCollectionCustomizationHttpAdapter } from "./http/handlers/collections/update-collection-customization.js";
import { ListCollectionsHttpAdapter } from "./http/handlers/collections/list-collections.js";
import { GetBlockspaceRangeSummaryHttpAdapter } from "./http/handlers/blockspace/get-blockspace-range-summary.js";
import { GetBlockspaceStateHttpAdapter } from "./http/handlers/blockspace/get-blockspace-state.js";
import { ScheduleBlockspaceBackfillHttpAdapter } from "./http/handlers/blockspace/schedule-blockspace-backfill.js";
import { GetRuntimeHealthHttpAdapter } from "./http/handlers/health/get-runtime-health.js";
import { ResolveOwnerRefHttpAdapter } from "./http/handlers/owners/resolve-owner-ref.js";
import { ListCollectionBiddingBidBookHttpAdapter } from "./http/handlers/trading/list-collection-bidding-bid-book.js";
import { ListCollectionBiddingPriceTiersHttpAdapter } from "./http/handlers/trading/list-collection-bidding-price-tiers.js";
import { GetTokenBiddingJobHttpAdapter } from "./http/handlers/trading/get-token-bidding-job.js";
import { GetTokenBiddingBidBookHttpAdapter } from "./http/handlers/trading/get-token-bidding-bid-book.js";
import { LookupBiddingJobTargetHttpAdapter } from "./http/handlers/trading/lookup-bidding-job-target.js";
import { UpsertTokenBiddingJobHttpAdapter } from "./http/handlers/trading/upsert-token-bidding-job.js";
import { UpsertTraitBiddingJobHttpAdapter } from "./http/handlers/trading/upsert-trait-bidding-job.js";
import { UpsertBatchTokenBiddingJobsHttpAdapter } from "./http/handlers/trading/upsert-batch-token-bidding-jobs.js";
import { UpsertCollectionBiddingJobHttpAdapter } from "./http/handlers/trading/upsert-collection-bidding-job.js";
import { UpsertCollectionBiddingPriceTierHttpAdapter } from "./http/handlers/trading/upsert-collection-bidding-price-tier.js";
import { UpdateCollectionBiddingSettingsHttpAdapter } from "./http/handlers/trading/update-collection-bidding-settings.js";
import { PreviewBiddingPriceTierReapplyHttpAdapter } from "./http/handlers/trading/preview-bidding-price-tier-reapply.js";
import { ApplyBiddingPriceTierReapplyHttpAdapter } from "./http/handlers/trading/apply-bidding-price-tier-reapply.js";
import { ArchiveBiddingJobHttpAdapter } from "./http/handlers/trading/archive-bidding-job.js";
import { ArchiveTokenBiddingJobHttpAdapter } from "./http/handlers/trading/archive-token-bidding-job.js";
import { ArchiveCollectionBiddingPriceTierHttpAdapter } from "./http/handlers/trading/archive-collection-bidding-price-tier.js";
import { createCommonHttpHandlers } from "./http/common/handlers.js";
import { registerApiErrorHandlers } from "./http/common/error-handlers.js";
import { registerApiResponseHeaders } from "./http/common/response-headers.js";
import {
    createIssueCsrfTokenHandler,
    registerApiSecurityHooks,
} from "./http/common/security.js";
import {
    createNoopBackendHttpObservability,
    registerBackendHttpObservabilityHooks,
    type BackendHttpObservability,
} from "./http/common/observability.js";
import { registerUserlandStaticRoutes } from "./http/common/userland-static.js";
import { registerTokenImageCacheStaticRoutes } from "./http/common/token-image-cache-static.js";
import { registerApiRoutes } from "./http-routes.js";
import type {
    BackendDeploymentConfig,
    BackendSecurityConfig,
} from "./config.js";

type MaybePromise<T> = T | Promise<T>;

type GetSyncBackfillStatePort = {
    getState(
        input: GetSyncBackfillStateInput,
    ): MaybePromise<GetSyncBackfillStateOutput>;
    getRangeSummary(
        input: GetSyncBackfillRangeSummaryInput,
    ): MaybePromise<GetSyncBackfillRangeSummaryOutput>;
};

type ScheduleSyncBackfillPort = {
    scheduleBackfill(
        input: ScheduleSyncBackfillInput,
    ): MaybePromise<ScheduleSyncBackfillOutput>;
};

export function createApiApp(
    createBootstrapRunUseCase: CreateBootstrapRunUseCase,
    probeCollectionContractUseCase: ProbeCollectionContractUseCase,
    listBootstrapRunsUseCase: ListBootstrapRunsUseCase,
    getBootstrapRunDetailUseCase: GetBootstrapRunDetailUseCase,
    getBootstrapStatusUseCase: GetBootstrapStatusUseCase,
    retryBootstrapRunFailedTasksUseCase: RetryBootstrapRunFailedTasksUseCase,
    applyBootstrapRunStepActionUseCase: ApplyBootstrapRunStepActionUseCase,
    getDefaultChainUseCase: GetDefaultChainUseCase,
    getRuntimeConfigUseCase: GetRuntimeConfigUseCase,
    listCollectionsUseCase: ListCollectionsUseCase,
    getSyncBackfillStateUseCase: GetSyncBackfillStatePort,
    scheduleSyncBackfillUseCase: ScheduleSyncBackfillPort,
    purgeCollectionUseCase: PurgeCollectionUseCase,
    resolveOwnerRefUseCase: ResolveOwnerRefUseCase,
    getCollectionActivityUseCase: GetCollectionActivityUseCase,
    getActivityEventPreviewUseCase: GetActivityEventPreviewUseCase,
    getTokenActivityUseCase: GetTokenActivityUseCase,
    getCollectionCustomizationUseCase: GetCollectionCustomizationUseCase,
    getCollectionTraitCatalogUseCase: GetCollectionTraitCatalogPort,
    getCollectionDetailUseCase: GetCollectionDetailPort,
    getCollectionHoldersUseCase: GetCollectionHoldersUseCase,
    getTokenDetailUseCase: GetTokenDetailUseCase,
    getTokenPreviewUseCase: GetTokenPreviewPort,
    getTokenUriUseCase: GetTokenUriUseCase,
    updateCollectionCustomizationUseCase: UpdateCollectionCustomizationUseCase,
    listCollectionBiddingBidBookUseCase: ListCollectionBiddingBidBookUseCase,
    listCollectionBiddingPriceTiersUseCase: ListCollectionBiddingPriceTiersUseCase,
    getTokenBiddingJobUseCase: GetTokenBiddingJobUseCase,
    getTokenBiddingBidBookUseCase: GetTokenBiddingBidBookUseCase,
    biddingJobTargetLookupUseCase: BiddingJobTargetLookupUseCase,
    upsertTokenBiddingJobUseCase: UpsertTokenBiddingJobUseCase,
    upsertTraitBiddingJobUseCase: UpsertTraitBiddingJobUseCase,
    upsertBatchTokenBiddingJobsUseCase: UpsertBatchTokenBiddingJobsUseCase,
    upsertCollectionBiddingJobUseCase: UpsertCollectionBiddingJobUseCase,
    upsertCollectionBiddingPriceTierUseCase: UpsertCollectionBiddingPriceTierUseCase,
    updateCollectionBiddingSettingsUseCase: UpdateCollectionBiddingSettingsUseCase,
    previewBiddingPriceTierReapplyUseCase: PreviewBiddingPriceTierReapplyUseCase,
    applyBiddingPriceTierReapplyUseCase: ApplyBiddingPriceTierReapplyUseCase,
    archiveBiddingJobUseCase: ArchiveBiddingJobUseCase,
    archiveTokenBiddingJobUseCase: ArchiveTokenBiddingJobUseCase,
    archiveCollectionBiddingPriceTierUseCase: ArchiveCollectionBiddingPriceTierUseCase,
    getRuntimeHealthUseCase: GetRuntimeHealthUseCase,
    tokenImageCacheDir: string,
    userlandUiDistDir: string | null,
    securityConfig: BackendSecurityConfig,
    deploymentConfig: BackendDeploymentConfig,
    observability: BackendHttpObservability = createNoopBackendHttpObservability(
        deploymentConfig.mode,
    ),
    publicGetSyncBackfillStateUseCase: GetSyncBackfillStatePort | null = null,
): FastifyInstance {
    const app = Fastify({
        logger: false,
    });

    const commonHandlers = createCommonHttpHandlers();
    const createBootstrapRunAdapter = new CreateBootstrapRunHttpAdapter(
        createBootstrapRunUseCase,
    );
    const probeCollectionContractAdapter =
        new ProbeCollectionContractHttpAdapter(probeCollectionContractUseCase);
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
    const applyBootstrapRunStepActionAdapter =
        new ApplyBootstrapRunStepActionHttpAdapter(
            applyBootstrapRunStepActionUseCase,
        );
    const getDefaultChainAdapter = new GetDefaultChainHttpAdapter(
        getDefaultChainUseCase,
    );
    const getRuntimeConfigAdapter = new GetRuntimeConfigHttpAdapter(
        getRuntimeConfigUseCase,
    );
    const listCollectionsAdapter = new ListCollectionsHttpAdapter(
        listCollectionsUseCase,
    );
    const getBlockspaceStateAdapter = new GetBlockspaceStateHttpAdapter(
        getSyncBackfillStateUseCase,
    );
    const getBlockspaceRangeSummaryAdapter =
        new GetBlockspaceRangeSummaryHttpAdapter(getSyncBackfillStateUseCase);
    const publicCollectionRef =
        deploymentConfig.publicCollectionScope?.collectionRef ?? null;
    const publicBlockspaceStatePort =
        publicGetSyncBackfillStateUseCase ?? getSyncBackfillStateUseCase;
    const publicGetBlockspaceStateAdapter = publicCollectionRef
        ? new GetBlockspaceStateHttpAdapter(
              publicBlockspaceStatePort,
              publicCollectionRef,
              "selected",
          )
        : null;
    const publicGetBlockspaceRangeSummaryAdapter = publicCollectionRef
        ? new GetBlockspaceRangeSummaryHttpAdapter(
              publicBlockspaceStatePort,
              publicCollectionRef,
          )
        : null;
    const scheduleBlockspaceBackfillAdapter =
        new ScheduleBlockspaceBackfillHttpAdapter(scheduleSyncBackfillUseCase);
    const purgeCollectionAdapter = new PurgeCollectionHttpAdapter(
        purgeCollectionUseCase,
    );
    const resolveOwnerRefAdapter = new ResolveOwnerRefHttpAdapter(
        resolveOwnerRefUseCase,
    );
    const getCollectionActivityAdapter = new GetCollectionActivityHttpAdapter(
        getCollectionActivityUseCase,
    );
    const getActivityEventPreviewAdapter =
        new GetActivityEventPreviewHttpAdapter(getActivityEventPreviewUseCase);
    const getTokenActivityAdapter = new GetTokenActivityHttpAdapter(
        getTokenActivityUseCase,
    );
    const getCollectionCustomizationAdapter =
        new GetCollectionCustomizationHttpAdapter(
            getCollectionCustomizationUseCase,
        );
    const getCollectionTraitCatalogAdapter =
        new GetCollectionTraitCatalogHttpAdapter(
            getCollectionTraitCatalogUseCase,
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
    const getTokenUriAdapter = new GetTokenUriHttpAdapter(getTokenUriUseCase);
    const updateCollectionCustomizationAdapter =
        new UpdateCollectionCustomizationHttpAdapter(
            updateCollectionCustomizationUseCase,
        );
    const listCollectionBiddingBidBookAdapter =
        new ListCollectionBiddingBidBookHttpAdapter(
            listCollectionBiddingBidBookUseCase,
            deploymentConfig.mode !== "public_single_collection",
        );
    const listCollectionBiddingPriceTiersAdapter =
        new ListCollectionBiddingPriceTiersHttpAdapter(
            listCollectionBiddingPriceTiersUseCase,
        );
    const getTokenBiddingJobAdapter = new GetTokenBiddingJobHttpAdapter(
        getTokenBiddingJobUseCase,
    );
    const getTokenBiddingBidBookAdapter = new GetTokenBiddingBidBookHttpAdapter(
        getTokenBiddingBidBookUseCase,
        deploymentConfig.mode !== "public_single_collection",
    );
    const lookupBiddingJobTargetAdapter = new LookupBiddingJobTargetHttpAdapter(
        biddingJobTargetLookupUseCase,
    );
    const upsertTokenBiddingJobAdapter = new UpsertTokenBiddingJobHttpAdapter(
        upsertTokenBiddingJobUseCase,
    );
    const upsertTraitBiddingJobAdapter = new UpsertTraitBiddingJobHttpAdapter(
        upsertTraitBiddingJobUseCase,
    );
    const upsertBatchTokenBiddingJobsAdapter =
        new UpsertBatchTokenBiddingJobsHttpAdapter(
            upsertBatchTokenBiddingJobsUseCase,
        );
    const upsertCollectionBiddingJobAdapter =
        new UpsertCollectionBiddingJobHttpAdapter(
            upsertCollectionBiddingJobUseCase,
        );
    const upsertCollectionBiddingPriceTierAdapter =
        new UpsertCollectionBiddingPriceTierHttpAdapter(
            upsertCollectionBiddingPriceTierUseCase,
        );
    const updateCollectionBiddingSettingsAdapter =
        new UpdateCollectionBiddingSettingsHttpAdapter(
            updateCollectionBiddingSettingsUseCase,
        );
    const previewBiddingPriceTierReapplyAdapter =
        new PreviewBiddingPriceTierReapplyHttpAdapter(
            previewBiddingPriceTierReapplyUseCase,
        );
    const applyBiddingPriceTierReapplyAdapter =
        new ApplyBiddingPriceTierReapplyHttpAdapter(
            applyBiddingPriceTierReapplyUseCase,
        );
    const archiveTokenBiddingJobAdapter = new ArchiveTokenBiddingJobHttpAdapter(
        archiveTokenBiddingJobUseCase,
    );
    const archiveBiddingJobAdapter = new ArchiveBiddingJobHttpAdapter(
        archiveBiddingJobUseCase,
    );
    const archiveCollectionBiddingPriceTierAdapter =
        new ArchiveCollectionBiddingPriceTierHttpAdapter(
            archiveCollectionBiddingPriceTierUseCase,
        );
    const getRuntimeHealthAdapter = new GetRuntimeHealthHttpAdapter(
        getRuntimeHealthUseCase,
    );
    const issueCsrfTokenHandler = createIssueCsrfTokenHandler(securityConfig);

    registerApiResponseHeaders(app, securityConfig);
    registerBackendHttpObservabilityHooks(app, observability);
    registerApiSecurityHooks(app, securityConfig);
    registerApiRoutes(
        app,
        commonHandlers,
        issueCsrfTokenHandler,
        createBootstrapRunAdapter,
        probeCollectionContractAdapter,
        listBootstrapRunsAdapter,
        getBootstrapRunDetailAdapter,
        getBootstrapStatusAdapter,
        retryBootstrapRunFailedTasksAdapter,
        applyBootstrapRunStepActionAdapter,
        getDefaultChainAdapter,
        getRuntimeConfigAdapter,
        listCollectionsAdapter,
        getBlockspaceStateAdapter,
        getBlockspaceRangeSummaryAdapter,
        publicGetBlockspaceStateAdapter,
        publicGetBlockspaceRangeSummaryAdapter,
        scheduleBlockspaceBackfillAdapter,
        purgeCollectionAdapter,
        resolveOwnerRefAdapter,
        getCollectionActivityAdapter,
        getActivityEventPreviewAdapter,
        getTokenActivityAdapter,
        getCollectionCustomizationAdapter,
        getCollectionTraitCatalogAdapter,
        getCollectionDetailAdapter,
        getCollectionHoldersAdapter,
        getTokenDetailAdapter,
        getTokenPreviewAdapter,
        getTokenUriAdapter,
        updateCollectionCustomizationAdapter,
        listCollectionBiddingBidBookAdapter,
        listCollectionBiddingPriceTiersAdapter,
        getTokenBiddingJobAdapter,
        getTokenBiddingBidBookAdapter,
        lookupBiddingJobTargetAdapter,
        upsertTokenBiddingJobAdapter,
        upsertTraitBiddingJobAdapter,
        upsertBatchTokenBiddingJobsAdapter,
        upsertCollectionBiddingJobAdapter,
        upsertCollectionBiddingPriceTierAdapter,
        updateCollectionBiddingSettingsAdapter,
        previewBiddingPriceTierReapplyAdapter,
        applyBiddingPriceTierReapplyAdapter,
        archiveBiddingJobAdapter,
        archiveTokenBiddingJobAdapter,
        archiveCollectionBiddingPriceTierAdapter,
        getRuntimeHealthAdapter,
        {
            publicCollectionScope: deploymentConfig.publicCollectionScope,
            includeAdminRoutes:
                deploymentConfig.mode !== "public_single_collection",
            includeCsrfRoute:
                deploymentConfig.mode !== "public_single_collection",
            observability,
        },
    );
    registerTokenImageCacheStaticRoutes(app, tokenImageCacheDir);
    if (userlandUiDistDir) {
        registerUserlandStaticRoutes(app, userlandUiDistDir);
    }
    registerApiErrorHandlers(app);

    return app;
}
