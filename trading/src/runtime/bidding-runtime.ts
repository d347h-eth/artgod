import { setDbPath } from "@artgod/shared/database";
import { OPENSEA_MAINNET_SECURITY_POLICY } from "@artgod/shared/trading/open-sea-mainnet-security-policy";
import {
    createResilientWeightedRpcTransport,
    createWeightedRpcTransport,
} from "@artgod/shared/evm/weighted-rpc-transport";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
} from "@artgod/shared/observability/rpc";
import {
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
} from "@artgod/shared/types";
import {
    LogLevel,
    Network,
    OpenSeaStreamClient as OpenSeaSdkStreamClient,
} from "@opensea/stream-js";
import { Chain, OpenSeaAPI } from "@opensea/sdk";
import { OpenSeaSDK } from "@opensea/sdk/viem";
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { NatsBiddingJobCommandSignalListener } from "../adapters/jobs/nats-bidding-job-command-signal-listener.js";
import { SqliteBiddingBidBookProjection } from "../adapters/bid-book/sqlite-bidding-bid-book-projection.js";
import { SqliteBiddingJobCommandRepository } from "../adapters/jobs/sqlite-bidding-job-command-repository.js";
import { SqliteBiddingJobRuntimeState } from "../adapters/jobs/sqlite-bidding-job-runtime-state.js";
import { SqliteBiddingJobSource } from "../adapters/jobs/sqlite-bidding-job-source.js";
import { SqliteTokenMetadataRepository } from "../adapters/metadata/sqlite-token-metadata-repository.js";
import { BiddingRuntimeMetrics } from "../adapters/observability/bidding-runtime-metrics.js";
import {
    BIDDING_OPEN_SEA_LANE,
    BIDDING_RUNTIME_METRIC_STATE,
    type BiddingRuntimeMetricState,
} from "../adapters/observability/bidding-runtime-metric-contract.js";
import { OpenSeaBiddingService } from "../adapters/opensea/open-sea-bidding-service.js";
import { OpenSeaCollectionOfferSource } from "../adapters/opensea/open-sea-collection-offer-source.js";
import { OpenSeaEventStream } from "../adapters/opensea/open-sea-event-stream.js";
import { OpenSeaMarketEventFactory } from "../adapters/opensea/open-sea-market-event-factory.js";
import {
    OpenSeaPolicyWallet,
    type OpenSeaPolicyTypedDataSigner,
} from "../adapters/opensea/open-sea-policy-wallet.js";
import { TokenBucketRateLimiter } from "../adapters/support/token-bucket-rate-limiter.js";
import { SqliteBiddingBotRuntimeState } from "../adapters/runtime/sqlite-bidding-bot-runtime-state.js";
import { ViemWethAllowanceApprovalService } from "../adapters/wallet/viem-weth-allowance-approval-service.js";
import { ViemMakerWethBalanceService } from "../adapters/wallet/viem-maker-weth-balance-service.js";
import { Bidder } from "../application/use-cases/bidding/bidder.js";
import {
    BIDDING_WORK_STAGE,
    observeBiddingWork,
} from "../application/use-cases/bidding/bidding-work-observability.js";
import { BiddingBidBookProjectionScheduler } from "../application/use-cases/bidding/bidding-bid-book-projection.js";
import {
    BIDDING_COMMAND_TRIGGER,
    BiddingJobCommandReconciler,
    type BiddingJobCommandProgress,
} from "../application/use-cases/bidding/bidding-job-command-reconciler.js";
import {
    CollectionOfferSnapshotService,
    type CollectionOfferBootstrapProgress,
} from "../application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    FailedOfferCancellationReconciler,
    type FailedOfferCancellationReconcilerConfig,
} from "../application/use-cases/bidding/failed-offer-cancellation-reconciler.js";
import { AttrFilter } from "../application/use-cases/market/pipeline/lib/attr-filter.js";
import { BidderRefresh } from "../application/use-cases/market/pipeline/lib/bidder-refresh.js";
import { CollectionOfferSnapshotRefresh } from "../application/use-cases/market/pipeline/lib/collection-offer-snapshot-refresh.js";
import {
    HOT_REFRESH_BACKPRESSURE_STAGE_NAME,
    HotRefreshBackpressure,
} from "../application/use-cases/market/pipeline/lib/hot-refresh-backpressure.js";
import {
    PipelineBuilder,
    type EventCallback,
} from "../application/use-cases/market/pipeline/pipeline.js";
import { StreamListener } from "../application/use-cases/stream/stream-listener.js";
import {
    EnabledBiddingConfig,
    TradingConfig,
} from "../config/trading-config.js";
import { MarketEvent, Type } from "../domain/market/event.js";
import type { BiddingMandate } from "../domain/bidding-mandate.js";
import {
    BIDDER_TARGET_TYPE,
    BidderJob,
} from "../domain/market/strategy/job.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../utils/bidding-log.js";
import { startBiddingCommandReconciliationLoop } from "./bidding-command-reconciliation-loop.js";
import { SampleBiddingRuntimeHealth } from "../application/use-cases/bidding/sample-bidding-runtime-health.js";
import { startBiddingHealthSamplingLoop } from "./bidding-health-sampling-loop.js";
import { startBiddingFailedCancellationReconciliationLoop } from "./bidding-failed-cancellation-reconciliation-loop.js";
import { createOpenSeaSdkRpcConnection } from "./opensea-sdk-rpc-connection.js";
import { buildMandateApprovalTransactionPolicy } from "./bidding-policy-agreement.js";
import {
    TRADING_RPC_ENDPOINT_ID_PREFIX,
    TRADING_RPC_LOG_COMPONENT,
    TRADING_RPC_OBSERVABILITY_COMPONENT,
} from "./observability.js";
import type {
    OpenSeaApiClient,
    OpenSeaBiddingSdkClient,
    OpenSeaCreateCollectionOfferResponse,
    OpenSeaCreateOfferResponse,
} from "../adapters/opensea/open-sea-client.js";

type BiddingRuntimeHandle = {
    shutdown(): Promise<void>;
};

type BidPipelineHandle = {
    callback: EventCallback;
    stop(): Promise<void>;
};

type StartBiddingRuntimeParams = {
    config: TradingConfig;
    biddingConfig: EnabledBiddingConfig;
    signingAccount: PrivateKeyAccount;
    walletId: string;
    lifecycle: BiddingRuntimeLifecyclePort;
    metrics: Metrics;
    biddingMandate: BiddingMandate;
};

type RegisteredBidStream = {
    collectionSlug: string;
    stream: OpenSeaEventStream;
    listener: StreamListener;
};

type BiddingRuntimeShutdownAction = () => void | Promise<void>;

type BiddingRuntimeShutdownStreamPort = {
    dispose(): void;
    disposeAndDrain(): Promise<void>;
};

// Drains a retired stream before removing the only shutdown-visible handle to it.
export async function disposeBiddingRuntimeBidStream<
    T extends { stream: BiddingRuntimeShutdownStreamPort },
>(bidStreams: Map<string, T>, collectionSlug: string): Promise<boolean> {
    const registered = bidStreams.get(collectionSlug);
    if (!registered) {
        return false;
    }

    try {
        await registered.stream.disposeAndDrain();
    } finally {
        bidStreams.delete(collectionSlug);
    }
    return true;
}

type BiddingRuntimeShutdownStreamRegistryPort = {
    values(): IterableIterator<{
        stream: BiddingRuntimeShutdownStreamPort;
    }>;
    clear(): void;
};

// Defines the runtime-owned resources and lifecycle observers that must settle during shutdown.
export type BiddingRuntimeShutdownPlan = {
    closeBidderBackgroundAdmission: BiddingRuntimeShutdownAction;
    closeCommandAdmission: BiddingRuntimeShutdownAction;
    commandAdmissionDrains: BiddingRuntimeShutdownAction[];
    bidPipelineDrain: BiddingRuntimeShutdownAction;
    bidderDrain: BiddingRuntimeShutdownAction;
    collectionSnapshotDrain: BiddingRuntimeShutdownAction;
    bidBookProjectionDrain: BiddingRuntimeShutdownAction;
    independentDrains: BiddingRuntimeShutdownAction[];
    bidStreams: BiddingRuntimeShutdownStreamRegistryPort;
    disconnectStreamClient: BiddingRuntimeShutdownAction;
    stopHeartbeat: BiddingRuntimeShutdownAction;
    markStopped: BiddingRuntimeShutdownAction;
    setMetricState(state: BiddingRuntimeMetricState): void;
    now(): number;
};

const log = createBiddingComponentLogger(BIDDING_LOG_COMPONENT.BiddingRuntime);
const openSeaSdkLog = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.OpenSeaSdk,
);

const BIDDING_RUNTIME_LOG_ACTION = {
    CommandJobPreparationStarted: "commandJobPreparationStarted",
    CommandSnapshotRefreshQueued: "commandSnapshotRefreshQueued",
    CommandSnapshotRefreshStarted: "commandSnapshotRefreshStarted",
    CommandSnapshotRefreshComplete: "commandSnapshotRefreshComplete",
    ShutdownComplete: "shutdownComplete",
} as const;

const BIDDING_RUNTIME_SHUTDOWN_RESULT = {
    Success: "success",
    Failure: "failure",
} as const;

// Failed-cancellation reconciliation stays small because it performs direct OpenSea order recovery.
const FAILED_CANCELLATION_RECONCILIATION_BATCH_SIZE = 25;

async function settleBiddingRuntimeShutdownActions(
    actions: BiddingRuntimeShutdownAction[],
    errors: unknown[],
): Promise<void> {
    const results = await Promise.allSettled(
        actions.map(async (action) => await action()),
    );
    results.forEach((result) => {
        if (result.status === "rejected") {
            errors.push(result.reason);
        }
    });
}

// Settles active operations and every cleanup attempt before publishing the stopped lifecycle state.
export async function shutdownBiddingRuntime(
    plan: BiddingRuntimeShutdownPlan,
): Promise<void> {
    const shutdownStartedAt = plan.now();
    const shutdownErrors: unknown[] = [];

    await settleBiddingRuntimeShutdownActions(
        [
            () =>
                plan.setMetricState(BIDDING_RUNTIME_METRIC_STATE.ShuttingDown),
            plan.closeBidderBackgroundAdmission,
            plan.closeCommandAdmission,
        ],
        shutdownErrors,
    );

    // Stop every command admission path and wait for each admitted command to settle.
    await settleBiddingRuntimeShutdownActions(
        plan.commandAdmissionDrains,
        shutdownErrors,
    );

    let registeredStreams: BiddingRuntimeShutdownStreamPort[] = [];
    await settleBiddingRuntimeShutdownActions(
        [
            () => {
                registeredStreams = Array.from(
                    plan.bidStreams.values(),
                    ({ stream }) => stream,
                );
            },
        ],
        shutdownErrors,
    );

    // Remove every stream subscription before waiting for admitted event handlers.
    await settleBiddingRuntimeShutdownActions(
        registeredStreams.map((stream) => () => stream.dispose()),
        shutdownErrors,
    );

    // Drain stream callbacks before stopping the pipeline that receives them.
    await settleBiddingRuntimeShutdownActions(
        registeredStreams.map((stream) => () => stream.disposeAndDrain()),
        shutdownErrors,
    );
    // Drain pipeline callbacks before waiting for the remaining admitted bidder work.
    await settleBiddingRuntimeShutdownActions(
        [plan.bidPipelineDrain],
        shutdownErrors,
    );
    await settleBiddingRuntimeShutdownActions(
        [plan.bidderDrain],
        shutdownErrors,
    );
    // Drain snapshot producers before stopping the projection that receives refreshed snapshots.
    await settleBiddingRuntimeShutdownActions(
        [plan.collectionSnapshotDrain],
        shutdownErrors,
    );
    await settleBiddingRuntimeShutdownActions(
        [plan.bidBookProjectionDrain],
        shutdownErrors,
    );
    // Settle remaining independent loops without weakening downstream drain ordering.
    await settleBiddingRuntimeShutdownActions(
        plan.independentDrains,
        shutdownErrors,
    );

    // Always release registry and socket resources even when an earlier drain failed.
    await settleBiddingRuntimeShutdownActions(
        [() => plan.bidStreams.clear()],
        shutdownErrors,
    );
    await settleBiddingRuntimeShutdownActions(
        [plan.disconnectStreamClient],
        shutdownErrors,
    );

    // Publish stopped only after every resource cleanup attempt has settled.
    await settleBiddingRuntimeShutdownActions(
        [plan.stopHeartbeat],
        shutdownErrors,
    );
    await settleBiddingRuntimeShutdownActions(
        [plan.markStopped],
        shutdownErrors,
    );
    const completionDurationMs = plan.now() - shutdownStartedAt;
    if (shutdownErrors.length > 0) {
        const { errorMessage, ...errorFields } = toErrorLogFields(
            shutdownErrors[0],
        );
        log.error(
            BIDDING_RUNTIME_LOG_ACTION.ShutdownComplete,
            "Bidding runtime shutdown completed with errors",
            {
                durationMs: completionDurationMs,
                result: BIDDING_RUNTIME_SHUTDOWN_RESULT.Failure,
                errorCount: shutdownErrors.length,
                errorMessage,
                ...errorFields,
            },
        );
        throw new AggregateError(
            shutdownErrors,
            "Bidding runtime shutdown did not complete cleanly",
        );
    }

    log.info(
        BIDDING_RUNTIME_LOG_ACTION.ShutdownComplete,
        "Bidding runtime shutdown completed",
        {
            durationMs: completionDurationMs,
            result: BIDDING_RUNTIME_SHUTDOWN_RESULT.Success,
            errorCount: 0,
        },
    );
}

// Maps typed runtime policy into the failed-cancellation use-case contract.
export function createFailedCancellationReconcilerConfig(
    chainId: number,
    cancellationRetryMs: number,
    dryRun: boolean,
): FailedOfferCancellationReconcilerConfig {
    return {
        chainId,
        batchSize: FAILED_CANCELLATION_RECONCILIATION_BATCH_SIZE,
        cancellationRetryMs,
        dryRun,
    };
}

export interface BiddingRuntimeLifecyclePort {
    bootstrapping(update: BiddingRuntimeBootstrapLifecycleUpdate): void;
    progress(update: BiddingRuntimeBootstrapLifecycleUpdate): void;
}

// Stable bootstrap phases are shared by the desktop lifecycle and runtime metrics.
export const BIDDING_RUNTIME_BOOTSTRAP_PHASE = {
    AllowanceApproval: BIDDING_WORK_STAGE.AllowanceApproval,
    SnapshotBootstrap: BIDDING_WORK_STAGE.SnapshotBootstrap,
    PriceBootstrap: BIDDING_WORK_STAGE.PriceBootstrap,
    CommandReconciliation: BIDDING_WORK_STAGE.CommandReconciliation,
} as const;

export type BiddingRuntimeBootstrapPhase =
    (typeof BIDDING_RUNTIME_BOOTSTRAP_PHASE)[keyof typeof BIDDING_RUNTIME_BOOTSTRAP_PHASE];

export interface BiddingRuntimeBootstrapLifecycleUpdate {
    phase: BiddingRuntimeBootstrapPhase;
    completed: number;
    total: number;
    detail: string;
}

// startBiddingRuntime wires the real bidding runtime and only resolves after bootstrap is complete.
export async function startBiddingRuntime(
    params: StartBiddingRuntimeParams,
): Promise<BiddingRuntimeHandle> {
    const runtimeStartedAt = Date.now();
    const observability = new BiddingRuntimeMetrics(params.metrics);
    observability.setRuntimeState(BIDDING_RUNTIME_METRIC_STATE.Bootstrapping);
    observability.recordConfiguration({
        maxConcurrentJobs: params.biddingConfig.maxConcurrentJobs,
        scanIntervalMs: params.biddingConfig.scanSleepMs,
        commandPollMs: params.biddingConfig.commandPollMs,
        commandBatchSize: params.biddingConfig.commandBatchSize,
        snapshotPollMs: params.biddingConfig.collectionOffersPollMs,
        snapshotTtlMs: params.biddingConfig.collectionOffersTtlMs,
        snapshotMaxTtlMs: params.biddingConfig.collectionOffersMaxTtlMs,
        snapshotTtlMultiplier:
            params.biddingConfig.collectionOffersAdaptiveTtlMultiplier,
        healthPollMs: params.biddingConfig.runtimeHeartbeat.intervalMs,
        hotRefreshBroadCooldownMs:
            params.biddingConfig.hotRefreshBroadCooldownMs,
        hotRefreshBroadMaxPending:
            params.biddingConfig.hotRefreshBroadMaxPendingSignatures,
        hotRefreshItemCooldownMs: params.biddingConfig.hotRefreshItemCooldownMs,
        hotRefreshItemMaxPending:
            params.biddingConfig.hotRefreshItemMaxPendingSignatures,
    });
    assertSupportedBiddingChain(params.config.chainId);
    const makerAddress = params.signingAccount.address;

    // Point the shared SQLite helpers at the runtime-selected ArtGod database before metadata adapters start reading.
    setDbPath(params.config.dbPath);

    const runtimeStateIdentity = {
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: params.config.chainId,
        walletId: params.walletId,
        address: makerAddress,
    };
    const runtimeState = new SqliteBiddingBotRuntimeState(
        params.biddingMandate.snapshot(),
        params.config.bidding.runtimeHeartbeat.intervalMs,
    );
    // Publish a bootstrapping heartbeat so backend readers can see the bot process is alive but not snapshot-ready.
    runtimeState.startHeartbeat(
        runtimeStateIdentity,
        TRADING_BOT_RUNTIME_STATE.Bootstrapping,
    );

    const biddingJobRuntimeState = new SqliteBiddingJobRuntimeState();
    biddingJobRuntimeState.invalidateEnabledActiveOrderVerification({
        chainId: params.config.chainId,
    });
    const biddingJobSource = new SqliteBiddingJobSource(params.config.chainId);
    // Load the authoritative enabled bidding jobs from SQLite before creating any market-facing adapters.
    log.info("loadJobs", "Loading bidding jobs from SQLite", {
        dbPath: params.config.dbPath,
        chainId: params.config.chainId,
    });
    const jobs = await biddingJobSource.loadEnabledJobs();
    const watchedCollectionSlugs = collectWatchedCollectionSlugs(jobs);
    const snapshotBackedCollectionSlugs =
        collectSnapshotBackedCollectionSlugs(jobs);
    const tokenWarmCandidates = collectTokenWarmCandidateCount(jobs);
    log.info("jobsLoaded", "Loaded bidding jobs", {
        jobCount: jobs.length,
        watchedCollectionCount: watchedCollectionSlugs.length,
        snapshotBackedCollectionCount: snapshotBackedCollectionSlugs.length,
        tokenWarmCandidateCount: tokenWarmCandidates,
    });

    const tokenMetadataRepository = new SqliteTokenMetadataRepository(
        params.config.chainId,
    );
    assertConfiguredRpcEndpoints(params.config.rpc.endpoints);
    const readOnlyRpcTransport = createResilientWeightedRpcTransport(
        params.config.rpc.endpoints,
        {
            endpointIdPrefix:
                TRADING_RPC_ENDPOINT_ID_PREFIX.BiddingReadOnlyViem,
            rpcObservability: createTradingRpcObservability(
                params.metrics,
                TRADING_RPC_OBSERVABILITY_COMPONENT.BiddingReadOnlyViem,
            ),
            resilience: params.config.rpc.resilience,
            retryPolicy: params.config.rpc.retryPolicy,
        },
    );
    const readOnlyPublicClient = createPublicClient({
        chain: mainnet,
        transport: readOnlyRpcTransport,
    });
    const makerWethBalanceService = new ViemMakerWethBalanceService(
        readOnlyPublicClient,
        params.config.tokens.wethAddress,
    );
    // Validate all ArtGod-owned OpenSea pins before constructing any transaction-capable client.
    const openSeaSigningCapability: OpenSeaPolicyTypedDataSigner = {
        address: makerAddress,
        signTypedData: async (input) =>
            await params.signingAccount.signTypedData(input as never),
    };
    const openSeaPolicyWallet = new OpenSeaPolicyWallet(
        openSeaSigningCapability,
        {
            wethAddress: params.config.tokens.wethAddress,
            biddingMandate: params.biddingMandate,
        },
    );
    const writeCapableRpcTransport = createWeightedRpcTransport(
        params.config.rpc.endpoints,
        {
            endpointIdPrefix:
                TRADING_RPC_ENDPOINT_ID_PREFIX.BiddingWriteCapableViem,
            rpcObservability: createTradingRpcObservability(
                params.metrics,
                TRADING_RPC_OBSERVABILITY_COMPONENT.BiddingWriteCapableViem,
            ),
            requestTimeoutMs: params.config.rpc.resilience.requestTimeoutMs,
        },
    );
    const allowanceWalletClient = createWalletClient({
        account: params.signingAccount,
        chain: mainnet,
        transport: writeCapableRpcTransport,
    });
    const approvalTransactionPolicy = buildMandateApprovalTransactionPolicy(
        params.biddingConfig,
        params.biddingMandate,
    );
    const wethAllowanceApprovalService = new ViemWethAllowanceApprovalService(
        readOnlyPublicClient,
        allowanceWalletClient,
        params.config.tokens.wethAddress,
        OPENSEA_MAINNET_SECURITY_POLICY.conduitAddress,
        {
            allowanceWei: params.biddingMandate.startPolicy.wethAllowanceCapWei,
            transactionPolicy: approvalTransactionPolicy,
            maxTotalGasFeeWei:
                params.biddingMandate.startPolicy.wethApproval
                    .maxTotalGasFeeWei,
        },
    );

    const allowanceApprovalTotal = 1;
    const reportAllowanceProgress = (detail: string): void => {
        params.lifecycle.progress({
            phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.AllowanceApproval,
            completed: 0,
            total: allowanceApprovalTotal,
            detail,
        });
    };
    // Tell the supervisor the runtime is live before any startup approval transaction can block.
    params.lifecycle.bootstrapping({
        phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.AllowanceApproval,
        completed: 0,
        total: allowanceApprovalTotal,
        detail: `cap=${formatWeth(params.biddingMandate.startPolicy.wethAllowanceCapWei)}, conduit=${OPENSEA_MAINNET_SECURITY_POLICY.conduitAddress}`,
    });
    // Reconcile the conduit allowance to the exact operator-configured WETH cap before any signing is possible.
    const allowanceResult = await observeBootstrapAction(
        observability,
        BIDDING_RUNTIME_BOOTSTRAP_PHASE.AllowanceApproval,
        async () =>
            await wethAllowanceApprovalService.ensureAllowance({
                ownerAddress: makerAddress,
                dryRun: params.biddingConfig.dryRun,
                onProgress: reportAllowanceProgress,
            }),
    );
    params.lifecycle.progress({
        phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.AllowanceApproval,
        completed: allowanceApprovalTotal,
        total: allowanceApprovalTotal,
        detail: `status=${allowanceResult.status}, cap=${formatWeth(allowanceResult.desiredAllowanceWei)}, previous=${formatWeth(allowanceResult.previousAllowanceWei)}, current=${formatWeth(allowanceResult.currentAllowanceWei)}`,
    });
    log.info(
        "allowanceBootstrapComplete",
        "Allowance approval bootstrap complete",
        {
            status: allowanceResult.status,
            desiredAllowanceWei: allowanceResult.desiredAllowanceWei.toString(),
            desiredAllowanceWeth: formatWeth(
                allowanceResult.desiredAllowanceWei,
            ),
            previousAllowanceWei:
                allowanceResult.previousAllowanceWei.toString(),
            previousAllowanceWeth: formatWeth(
                allowanceResult.previousAllowanceWei,
            ),
            currentAllowanceWei: allowanceResult.currentAllowanceWei.toString(),
            currentAllowanceWeth: formatWeth(
                allowanceResult.currentAllowanceWei,
            ),
        },
    );

    // Give OpenSea only the policy wallet; the SDK receives no transaction-capable wallet authority.
    const sdkRpcConnection = createOpenSeaSdkRpcConnection(
        params.config.rpc.endpoints,
        {
            endpointIdPrefix: TRADING_RPC_ENDPOINT_ID_PREFIX.OpenSeaSdk,
            rpcObservability: createTradingRpcObservability(
                params.metrics,
                TRADING_RPC_OBSERVABILITY_COMPONENT.OpenSeaSdk,
            ),
            requestTimeoutMs: params.config.rpc.resilience.requestTimeoutMs,
        },
    );
    const biddingSdk = createBiddingSdkClient(
        readOnlyPublicClient as unknown as PublicClient,
        openSeaPolicyWallet,
        sdkRpcConnection,
        params.biddingConfig.openSea.biddingSecretKey,
    );
    const bidBookProjection = new BiddingBidBookProjectionScheduler(
        new SqliteBiddingBidBookProjection(
            params.config.chainId,
            makerAddress,
            params.config.tokens.wethAddress,
        ),
        params.biddingConfig.bidBookProjectionThrottleMs,
        observability,
        snapshotBackedCollectionSlugs,
    );
    const snapshotOpenSeaObservability =
        observability.createOpenSeaOperationObserver(
            BIDDING_OPEN_SEA_LANE.Snapshot,
        );
    const biddingOpenSeaObservability =
        observability.createOpenSeaOperationObserver(
            BIDDING_OPEN_SEA_LANE.Bidding,
        );
    const collectionOfferSnapshotService = new CollectionOfferSnapshotService(
        // Create the dedicated snapshot API lane so polling never shares the bidding key or limiter.
        new OpenSeaCollectionOfferSource(
            createSnapshotApiClient(
                params.biddingConfig.openSea.snapshotSecretKey,
            ),
            {
                retryPolicy: params.biddingConfig.openSea.http.retryPolicy,
                rateLimiter: new TokenBucketRateLimiter(
                    params.biddingConfig.openSea.http.rateLimiter,
                    Date.now,
                    observability.createRateLimiterObserver(
                        BIDDING_OPEN_SEA_LANE.Snapshot,
                    ),
                ),
                observability: snapshotOpenSeaObservability,
            },
        ),
        snapshotBackedCollectionSlugs,
        params.biddingConfig.collectionOffersPollMs,
        params.biddingConfig.collectionOffersTtlMs,
        {
            onWorkStarted: (stage) => observability.onWorkStarted(stage),
            onSnapshotRefreshed: (snapshot, reason) => {
                bidBookProjection.requestProjection(snapshot, reason);
            },
            onSnapshotRefreshRequest: (input) => {
                observability.onSnapshotRefreshRequest(input);
            },
            onSnapshotRefreshFinished: (input) => {
                observability.onSnapshotRefreshFinished(input);
            },
            onSnapshotStateChanged: (input) => {
                observability.onSnapshotStateChanged(input);
            },
        },
        {
            maxTtlMs: params.biddingConfig.collectionOffersMaxTtlMs,
            durationMultiplier:
                params.biddingConfig.collectionOffersAdaptiveTtlMultiplier,
        },
    );

    const biddingService = new OpenSeaBiddingService(biddingSdk, makerAddress, {
        collectionOfferSnapshotProvider: collectionOfferSnapshotService,
        tokenMetadataRepository,
        offerExpirationSeconds: params.biddingConfig.offerExpirationSeconds,
        orderLookupMaxPages: params.biddingConfig.orderLookupMaxPages,
        retryPolicy: params.biddingConfig.openSea.http.retryPolicy,
        rateLimiter: new TokenBucketRateLimiter(
            params.biddingConfig.openSea.http.rateLimiter,
            Date.now,
            observability.createRateLimiterObserver(
                BIDDING_OPEN_SEA_LANE.Bidding,
            ),
        ),
        observability: biddingOpenSeaObservability,
        tokenCriteriaTraitsByCollection:
            params.biddingConfig.tokenCriteriaTraitsByCollection,
        competitiveTraitMaxLookupSelectors:
            params.biddingConfig.competitiveTraitMaxLookupSelectors,
        trustOpenSeaSignedZoneTraitOffers:
            params.biddingMandate.startPolicy.trustOpenSeaSignedZoneTraitOffers,
    });
    const bidder = new Bidder(
        biddingService,
        makerAddress,
        params.biddingConfig.scanSleepMs,
        {
            dryRun: params.biddingConfig.dryRun,
            maxConcurrentJobs: params.biddingConfig.maxConcurrentJobs,
            bootstrapConcurrency: params.biddingConfig.bootstrapConcurrency,
        },
        tokenMetadataRepository,
        makerWethBalanceService,
        biddingJobRuntimeState,
        observability,
    );

    // Register all configured jobs before bootstrapping snapshot state or current prices.
    jobs.forEach((job) => bidder.addJob(job));

    const commandRepository = new SqliteBiddingJobCommandRepository();
    const healthLoop = params.config.metrics.enabled
        ? startBiddingHealthSamplingLoop(
              new SampleBiddingRuntimeHealth(
                  commandRepository,
                  collectionOfferSnapshotService,
                  bidBookProjection,
                  bidder,
                  observability,
                  params.biddingConfig.commandClaimTimeoutMs,
              ),
              params.biddingConfig.runtimeHeartbeat.intervalMs,
          )
        : undefined;
    let ready = false;
    try {
        if (snapshotBackedCollectionSlugs.length > 0) {
            // Tell the supervisor the runtime is live and entering the authoritative snapshot bootstrap phase.
            params.lifecycle.bootstrapping({
                phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.SnapshotBootstrap,
                completed: 0,
                total: snapshotBackedCollectionSlugs.length,
                detail: `collections=${snapshotBackedCollectionSlugs.length}, tokenWarmCandidates=${tokenWarmCandidates}`,
            });
            // Build the authoritative collection snapshots before the bidder starts reacting to live stream signals.
            const snapshotBootstrapProgress =
                createSnapshotBootstrapProgressReporter(
                    params,
                    snapshotBackedCollectionSlugs.length,
                    tokenWarmCandidates,
                );
            const stopSnapshotBootstrapProgressPulse =
                startBootstrapProgressPulse(snapshotBootstrapProgress);
            try {
                await observeBootstrapAction(
                    observability,
                    BIDDING_RUNTIME_BOOTSTRAP_PHASE.SnapshotBootstrap,
                    async () =>
                        await collectionOfferSnapshotService.bootstrap({
                            onCollectionStarted: (progress) => {
                                snapshotBootstrapProgress.reportStarted(
                                    progress,
                                );
                            },
                            onProgress: (progress) => {
                                snapshotBootstrapProgress.reportFinished(
                                    progress,
                                );
                            },
                        }),
                );
            } finally {
                stopSnapshotBootstrapProgressPulse();
            }
            params.lifecycle.progress({
                phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.SnapshotBootstrap,
                completed: snapshotBackedCollectionSlugs.length,
                total: snapshotBackedCollectionSlugs.length,
                detail: `collections=${snapshotBackedCollectionSlugs.length}, status=complete`,
            });
        }

        // Tell the supervisor the runtime is still healthy while current-price warmup is running for token jobs.
        params.lifecycle.bootstrapping({
            phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.PriceBootstrap,
            completed: 0,
            total: tokenWarmCandidates,
            detail: `snapshotCollections=${snapshotBackedCollectionSlugs.length}, tokenWarmCandidates=${tokenWarmCandidates}`,
        });
        // Warm token-job current prices so the first bidder loop starts from real market context.
        await observeBootstrapAction(
            observability,
            BIDDING_RUNTIME_BOOTSTRAP_PHASE.PriceBootstrap,
            async () =>
                await bidder.bootstrapCurrentPrices({
                    onProgress: ({ jobId, completed, total, warmed }) => {
                        params.lifecycle.progress({
                            phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.PriceBootstrap,
                            completed,
                            total,
                            detail: `jobId=${jobId}, warmed=${warmed}`,
                        });
                    },
                }),
        );

        const streamClient = createStreamClient(
            params.biddingConfig.openSea.streamSecretKey,
        );
        const bidPipeline = buildBidPipeline(
            makerAddress,
            bidder,
            collectionOfferSnapshotService,
            params.biddingConfig.criteriaRefreshTraitsByCollection,
            params.biddingConfig.hotRefreshBroadCooldownMs,
            params.biddingConfig.hotRefreshBroadMaxPendingSignatures,
            params.biddingConfig.hotRefreshItemCooldownMs,
            params.biddingConfig.hotRefreshItemMaxPendingSignatures,
            params.biddingConfig.maxConcurrentJobs,
            observability,
        );
        const bidStreams = new Map<string, RegisteredBidStream>();
        let bidStreamSubscriptionsEnabled = false;
        const pendingBidStreamCollections = new Set<string>();
        const ensureBidStream = (collectionSlug: string): boolean => {
            if (!bidStreamSubscriptionsEnabled) {
                pendingBidStreamCollections.add(collectionSlug);
                return false;
            }

            if (bidStreams.has(collectionSlug)) {
                return false;
            }

            // Subscribe the direct OpenSea bid stream when a DB-driven job introduces a watched collection.
            bidStreams.set(
                collectionSlug,
                registerBidStream(
                    streamClient,
                    collectionSlug,
                    bidPipeline.callback,
                    observability,
                ),
            );
            log.info(
                "bidStreamSubscribed",
                "Subscribed direct OpenSea bid stream",
                {
                    collectionSlug,
                    streamCollectionCount: bidStreams.size,
                },
            );
            return true;
        };
        const disposeBidStream = async (
            collectionSlug: string,
        ): Promise<boolean> => {
            const removed = await disposeBiddingRuntimeBidStream(
                bidStreams,
                collectionSlug,
            );
            if (!removed) {
                return false;
            }

            log.info(
                "bidStreamUnsubscribed",
                "Unsubscribed direct OpenSea bid stream",
                {
                    collectionSlug,
                    streamCollectionCount: bidStreams.size,
                },
            );
            return true;
        };
        const reconcileBidStreams = async (
            collectionSlugs: string[],
        ): Promise<{
            added: number;
            removed: number;
        }> => {
            const next = new Set(collectionSlugs);
            let added = 0;
            let removed = 0;

            if (!bidStreamSubscriptionsEnabled) {
                pendingBidStreamCollections.clear();
                next.forEach((collectionSlug) =>
                    pendingBidStreamCollections.add(collectionSlug),
                );
                return { added, removed };
            }

            const retiredCollections = Array.from(bidStreams.keys()).filter(
                (collectionSlug) => !next.has(collectionSlug),
            );
            const retirementResults = await Promise.allSettled(
                retiredCollections.map((collectionSlug) =>
                    disposeBidStream(collectionSlug),
                ),
            );
            for (const retirementResult of retirementResults) {
                if (
                    retirementResult.status === "fulfilled" &&
                    retirementResult.value
                ) {
                    removed += 1;
                }
            }

            for (const collectionSlug of next) {
                if (ensureBidStream(collectionSlug)) {
                    added += 1;
                }
            }

            const retirementErrors = retirementResults.flatMap(
                (retirementResult) =>
                    retirementResult.status === "rejected"
                        ? [retirementResult.reason]
                        : [],
            );
            if (retirementErrors.length === 1) {
                throw retirementErrors[0];
            }
            if (retirementErrors.length > 1) {
                throw new AggregateError(
                    retirementErrors,
                    "Failed to retire bidding streams",
                );
            }

            return { added, removed };
        };
        const enableBidStreams = async (
            collectionSlugs: string[],
        ): Promise<void> => {
            bidStreamSubscriptionsEnabled = true;
            const desiredCollections = new Set(collectionSlugs);
            pendingBidStreamCollections.forEach((collectionSlug) =>
                desiredCollections.add(collectionSlug),
            );
            pendingBidStreamCollections.clear();
            await reconcileBidStreams(Array.from(desiredCollections));
        };

        const commandReconciler = new BiddingJobCommandReconciler(
            commandRepository,
            biddingJobSource,
            bidder,
            {
                prepareEnabledJob: async (job) => {
                    log.info(
                        BIDDING_RUNTIME_LOG_ACTION.CommandJobPreparationStarted,
                        "Preparing enabled bidding job command",
                        {
                            jobId: job.id,
                            collectionSlug: job.collectionSlug,
                            targetType: job.target.type,
                        },
                    );
                    ensureBidStream(job.collectionSlug);
                    if (
                        job.target.type === BIDDER_TARGET_TYPE.Token ||
                        job.target.type === BIDDER_TARGET_TYPE.Collection
                    ) {
                        collectionOfferSnapshotService.watchCollection(
                            job.collectionSlug,
                        );
                        const existingSnapshot =
                            collectionOfferSnapshotService.getSnapshot(
                                job.collectionSlug,
                            );
                        if (existingSnapshot) {
                            log.info(
                                BIDDING_RUNTIME_LOG_ACTION.CommandSnapshotRefreshQueued,
                                "Queued collection-offer snapshot refresh for bidding job command",
                                {
                                    jobId: job.id,
                                    collectionSlug: job.collectionSlug,
                                    targetType: job.target.type,
                                    snapshotAgeMs:
                                        Date.now() -
                                        existingSnapshot.refreshedAt,
                                },
                            );
                            // Reuse the latest market snapshot for command evaluation and refresh it asynchronously when stale.
                            collectionOfferSnapshotService.requestRefresh(
                                job.collectionSlug,
                                `job command reconciliation: ${job.id}`,
                            );
                            return;
                        }

                        log.info(
                            BIDDING_RUNTIME_LOG_ACTION.CommandSnapshotRefreshStarted,
                            "Refreshing collection-offer snapshot for bidding job command",
                            {
                                jobId: job.id,
                                collectionSlug: job.collectionSlug,
                                targetType: job.target.type,
                            },
                        );
                        // Refresh the authoritative snapshot before the reconciled job performs an immediate bid pass.
                        await collectionOfferSnapshotService.refreshAndWait(
                            job.collectionSlug,
                            `job command reconciliation: ${job.id}`,
                            { respectTtl: false },
                        );
                        log.info(
                            BIDDING_RUNTIME_LOG_ACTION.CommandSnapshotRefreshComplete,
                            "Collection-offer snapshot refreshed for bidding job command",
                            {
                                jobId: job.id,
                                collectionSlug: job.collectionSlug,
                                targetType: job.target.type,
                            },
                        );
                    }
                },
                reconcileEnabledJobs: async (enabledJobs) => {
                    const nextStreamCollections =
                        collectWatchedCollectionSlugs(enabledJobs);
                    await reconcileBidStreams(nextStreamCollections);
                    const nextSnapshotCollections =
                        collectSnapshotBackedCollectionSlugs(enabledJobs);
                    collectionOfferSnapshotService.reconcileWatchedCollections(
                        nextSnapshotCollections,
                    );
                    bidBookProjection.reconcileWatchedCollections(
                        nextSnapshotCollections,
                    );
                },
            },
            {
                batchSize: params.biddingConfig.commandBatchSize,
                claimTimeoutMs: params.biddingConfig.commandClaimTimeoutMs,
                maxAttempts: params.biddingConfig.commandMaxAttempts,
            },
            biddingJobRuntimeState,
            observability,
        );
        // Process any committed DB commands before the normal bidder loop starts.
        params.lifecycle.bootstrapping({
            phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.CommandReconciliation,
            completed: 0,
            total: params.biddingConfig.commandBatchSize,
            detail: "trigger=startup",
        });
        const startupCommandProgress =
            createStartupCommandProgressReporter(params);
        const stopStartupCommandProgressPulse = startBootstrapProgressPulse(
            startupCommandProgress,
        );
        let startupCommandCount = 0;
        try {
            startupCommandCount = await observeBootstrapAction(
                observability,
                BIDDING_RUNTIME_BOOTSTRAP_PHASE.CommandReconciliation,
                async () =>
                    await commandReconciler.processPendingCommands(
                        BIDDING_COMMAND_TRIGGER.Startup,
                        {
                            onCommandStarted: (progress) => {
                                startupCommandProgress.reportStarted(progress);
                            },
                            onCommandFinished: (progress) => {
                                startupCommandProgress.reportFinished(progress);
                            },
                        },
                    ),
            );
        } finally {
            stopStartupCommandProgressPulse();
        }
        params.lifecycle.progress({
            phase: BIDDING_RUNTIME_BOOTSTRAP_PHASE.CommandReconciliation,
            completed: startupCommandCount,
            total: params.biddingConfig.commandBatchSize,
            detail: `processed=${startupCommandCount}`,
        });

        const startupEnabledJobs = await biddingJobSource.loadEnabledJobs();
        await enableBidStreams(
            collectWatchedCollectionSlugs(startupEnabledJobs),
        );
        collectionOfferSnapshotService.reconcileWatchedCollections(
            collectSnapshotBackedCollectionSlugs(startupEnabledJobs),
        );
        bidBookProjection.reconcileWatchedCollections(
            collectSnapshotBackedCollectionSlugs(startupEnabledJobs),
        );

        // Start steady-state snapshot polling only after startup command replay cannot compete with poll work.
        collectionOfferSnapshotService.start();

        // Start the steady-state bidder scan loop only after stream listeners and warm state are ready.
        bidder.start();

        const commandLoop = startBiddingCommandReconciliationLoop(
            commandReconciler,
            params.biddingConfig.commandPollMs,
        );
        const failedCancellationReconciler =
            new FailedOfferCancellationReconciler(
                biddingJobRuntimeState,
                biddingService,
                createFailedCancellationReconcilerConfig(
                    params.config.chainId,
                    params.biddingConfig.cancellationRemediationRetryMs,
                    params.biddingConfig.dryRun,
                ),
            );
        const failedCancellationLoop =
            startBiddingFailedCancellationReconciliationLoop(
                failedCancellationReconciler,
                params.biddingConfig.failedCancellationReconcileMs,
            );
        const signalListener = await startBiddingJobCommandSignalListener(
            params.config.queue.natsUrl,
            params.config.queue.streamPrefix,
            commandReconciler,
        );

        log.info("bidderStarted", "Started bidder", {
            jobCount: jobs.length,
            watchedCollectionCount: watchedCollectionSlugs.length,
            snapshotCollectionCount: snapshotBackedCollectionSlugs.length,
            dryRun: params.biddingConfig.dryRun,
        });
        // Switch to running heartbeat only after bootstrap and steady-state loops have started.
        runtimeState.startHeartbeat(
            runtimeStateIdentity,
            TRADING_BOT_RUNTIME_STATE.Running,
        );
        observability.observeTimeToReady(Date.now() - runtimeStartedAt);
        observability.setRuntimeState(BIDDING_RUNTIME_METRIC_STATE.Running);
        ready = true;

        return {
            async shutdown(): Promise<void> {
                await shutdownBiddingRuntime({
                    closeBidderBackgroundAdmission: () =>
                        bidder.closeBackgroundRefreshAdmission(),
                    closeCommandAdmission: () =>
                        commandReconciler.closeAdmission(),
                    commandAdmissionDrains: [
                        () => commandLoop.shutdown(),
                        ...(signalListener
                            ? [() => signalListener.shutdown()]
                            : []),
                    ],
                    bidPipelineDrain: () => bidPipeline.stop(),
                    bidderDrain: () => bidder.stop(),
                    collectionSnapshotDrain: () =>
                        collectionOfferSnapshotService.stop(),
                    bidBookProjectionDrain: () => bidBookProjection.stop(),
                    independentDrains: [
                        () => failedCancellationLoop.shutdown(),
                        () => healthLoop?.shutdown(),
                    ],
                    bidStreams,
                    // Disconnect the shared OpenSea socket after every per-collection handler settles.
                    disconnectStreamClient: () => streamClient.disconnect(),
                    stopHeartbeat: () => runtimeState.stopHeartbeat(),
                    // Mark the bot stopped so backend reads fall back to indexed orders immediately.
                    markStopped: () =>
                        runtimeState.markState(
                            runtimeStateIdentity,
                            TRADING_BOT_RUNTIME_STATE.Stopped,
                        ),
                    setMetricState: (state) =>
                        observability.setRuntimeState(state),
                    now: Date.now,
                });
            },
        };
    } finally {
        // A failed bootstrap must not leave the newly introduced monitoring loop alive.
        if (!ready) await healthLoop?.shutdown();
    }
}

// collectWatchedCollectionSlugs returns every collection that needs a direct OpenSea bid stream subscription.
export function collectWatchedCollectionSlugs(jobs: BidderJob[]): string[] {
    return Array.from(new Set(jobs.map((job) => job.collectionSlug)));
}

// collectSnapshotBackedCollectionSlugs keeps the dedicated snapshot lane scoped to token and collection jobs only.
export function collectSnapshotBackedCollectionSlugs(
    jobs: BidderJob[],
): string[] {
    return Array.from(
        new Set(
            jobs
                .filter(
                    (job) =>
                        job.target.type === BIDDER_TARGET_TYPE.Token ||
                        job.target.type === BIDDER_TARGET_TYPE.Collection,
                )
                .map((job) => job.collectionSlug),
        ),
    );
}

// collectTokenWarmCandidateCount approximates the size of the current-price bootstrap pass before runtime state exists.
export function collectTokenWarmCandidateCount(jobs: BidderJob[]): number {
    return jobs.filter((job) => job.target.type === BIDDER_TARGET_TYPE.Token)
        .length;
}

type BootstrapProgressPulseReporter = {
    reportPulse(): void;
    intervalMs: number;
};

type SnapshotBootstrapProgressReporter = BootstrapProgressPulseReporter & {
    reportStarted(progress: CollectionOfferBootstrapProgress): void;
    reportFinished(progress: CollectionOfferBootstrapProgress): void;
};

type StartupCommandProgressReporter = BootstrapProgressPulseReporter & {
    reportStarted(progress: BiddingJobCommandProgress): void;
    reportFinished(
        progress: BiddingJobCommandProgress & { succeeded: boolean },
    ): void;
};

function createSnapshotBootstrapProgressReporter(
    params: StartBiddingRuntimeParams,
    total: number,
    tokenWarmCandidates: number,
): SnapshotBootstrapProgressReporter {
    const phase = BIDDING_RUNTIME_BOOTSTRAP_PHASE.SnapshotBootstrap;
    const state = {
        completed: 0,
        detail: `collections=${total}, tokenWarmCandidates=${tokenWarmCandidates}`,
    };
    const emit = (): void => {
        params.lifecycle.progress({
            phase,
            completed: state.completed,
            total,
            detail: state.detail,
        });
    };

    return {
        intervalMs: params.biddingConfig.runtimeHeartbeat.intervalMs,
        reportStarted(progress) {
            state.completed = progress.completed;
            state.detail = `collection=${progress.collectionSlug}, status=refreshing`;
            emit();
        },
        reportFinished(progress) {
            state.completed = progress.completed;
            state.detail = `collection=${progress.collectionSlug}, status=refreshed`;
            emit();
        },
        reportPulse: emit,
    };
}

function createStartupCommandProgressReporter(
    params: StartBiddingRuntimeParams,
): StartupCommandProgressReporter {
    const phase = BIDDING_RUNTIME_BOOTSTRAP_PHASE.CommandReconciliation;
    const total = params.biddingConfig.commandBatchSize;
    const state = {
        completed: 0,
        detail: "trigger=startup",
    };
    const emit = (): void => {
        params.lifecycle.progress({
            phase,
            completed: state.completed,
            total,
            detail: state.detail,
        });
    };

    return {
        intervalMs: params.biddingConfig.runtimeHeartbeat.intervalMs,
        reportStarted(progress) {
            state.completed = Math.max(0, progress.processed - 1);
            state.detail = `commandId=${progress.commandId}, kind=${progress.commandKind}, jobId=${progress.jobId}`;
            emit();
        },
        reportFinished(progress) {
            state.completed = progress.processed;
            state.detail = `processed=${progress.processed}, commandId=${progress.commandId}, kind=${progress.commandKind}, succeeded=${progress.succeeded}`;
            emit();
        },
        reportPulse: emit,
    };
}

function startBootstrapProgressPulse(
    reporter: BootstrapProgressPulseReporter,
): () => void {
    const timer = setInterval(() => {
        reporter.reportPulse();
    }, reporter.intervalMs);
    return () => clearInterval(timer);
}

async function observeBootstrapAction<T>(
    observability: BiddingRuntimeMetrics,
    phase: BiddingRuntimeBootstrapPhase,
    action: () => Promise<T>,
): Promise<T> {
    const startedAt = Date.now();
    let succeeded = false;
    try {
        const result = await observeBiddingWork(observability, phase, action);
        succeeded = true;
        return result;
    } finally {
        observability.observeBootstrapPhase({
            phase,
            durationMs: Date.now() - startedAt,
            succeeded,
        });
    }
}

// createCriteriaOfferRefreshReasonResolver keeps stream-side snapshot nudges limited to relevant collection/trait signals.
export function createCriteriaOfferRefreshReasonResolver(
    criteriaRefreshTraitsByCollection: Record<string, string[]>,
): (marketEvent: MarketEvent) => string | null {
    const watchedTraitsByCollection = Object.fromEntries(
        Object.entries(criteriaRefreshTraitsByCollection).map(
            ([collectionSlug, traitTypes]) => [
                collectionSlug,
                new Set(traitTypes),
            ],
        ),
    ) as Record<string, Set<string>>;

    return (marketEvent: MarketEvent): string | null => {
        if (
            marketEvent.getType() !== Type.TraitOffer &&
            marketEvent.getType() !== Type.CollectionOffer
        ) {
            return null;
        }

        const watchedTraits =
            watchedTraitsByCollection[marketEvent.getCollectionSlug()];
        if (!watchedTraits) {
            return null;
        }

        const matchedTraits = Array.from(
            new Set(
                marketEvent
                    .getTraitCriteria()
                    .map((criterion) => criterion.type)
                    .filter((traitType) => watchedTraits.has(traitType)),
            ),
        );
        if (matchedTraits.length === 0) {
            return null;
        }

        return `eventType=${marketEvent.getType()}, matchedTraits=${matchedTraits.join("|")}`;
    };
}

function buildBidPipeline(
    makerAddress: string,
    bidder: Bidder,
    collectionOfferSnapshotService: CollectionOfferSnapshotService | undefined,
    criteriaRefreshTraitsByCollection: Record<string, string[]>,
    hotRefreshBroadCooldownMs: number,
    hotRefreshBroadMaxPendingSignatures: number,
    hotRefreshItemCooldownMs: number,
    hotRefreshItemMaxPendingSignatures: number,
    maxConcurrentJobs: number,
    observability: BiddingRuntimeMetrics,
): BidPipelineHandle {
    const opponentBidsFilter = new AttrFilter("opponent-bids");
    opponentBidsFilter.addCriteria("opponent-only", (marketEvent) => {
        return (
            marketEvent.getMaker().toLowerCase() !== makerAddress.toLowerCase()
        );
    });
    const hotRefreshBackpressure = new HotRefreshBackpressure(
        HOT_REFRESH_BACKPRESSURE_STAGE_NAME.StreamEvents,
        {
            broadCooldownMs: hotRefreshBroadCooldownMs,
            broadMaxPendingSignatures: hotRefreshBroadMaxPendingSignatures,
            itemCooldownMs: hotRefreshItemCooldownMs,
            itemMaxPendingSignatures: hotRefreshItemMaxPendingSignatures,
            maxConcurrentPasses: maxConcurrentJobs,
        },
        observability,
    );

    const pipelineBuilder = new PipelineBuilder()
        .with(opponentBidsFilter)
        .with(hotRefreshBackpressure);
    if (collectionOfferSnapshotService) {
        pipelineBuilder.with(
            new CollectionOfferSnapshotRefresh(
                "criteria-offer-cache-refresh",
                collectionOfferSnapshotService,
                createCriteriaOfferRefreshReasonResolver(
                    criteriaRefreshTraitsByCollection,
                ),
            ),
        );
    }

    pipelineBuilder.with(new BidderRefresh("bidder-hot-refresh", bidder));
    return {
        callback: pipelineBuilder.build(),
        stop: () => hotRefreshBackpressure.stop(),
    };
}

function registerBidStream(
    streamClient: OpenSeaSdkStreamClient,
    collectionSlug: string,
    bidPipeline: Parameters<StreamListener["attachHandler"]>[1],
    observability: BiddingRuntimeMetrics,
): RegisteredBidStream {
    // Subscribe the direct OpenSea bid stream for each watched collection.
    const stream = new OpenSeaEventStream(
        streamClient,
        collectionSlug,
        new OpenSeaMarketEventFactory(),
        observability,
    )
        .withItemReceivedBid()
        .withCollectionOffer()
        .withTraitOffer();
    const listener = new StreamListener(stream);

    // Attach the hot-refresh pipeline only after the bidder bootstrap path already completed.
    listener.attachHandler(
        `${collectionSlug}-item-received-bid-filtered`,
        bidPipeline,
    );

    return {
        collectionSlug,
        stream,
        listener,
    };
}

async function startBiddingJobCommandSignalListener(
    natsUrl: string,
    streamPrefix: string,
    commandReconciler: BiddingJobCommandReconciler,
) {
    const listener = new NatsBiddingJobCommandSignalListener({
        natsUrl,
        streamPrefix,
        consumerName: "trading-bidding-bot-command-signals",
    });
    try {
        return await listener.start(async () => {
            await commandReconciler.processPendingCommands(
                BIDDING_COMMAND_TRIGGER.Signal,
            );
        });
    } catch (error) {
        log.warn(
            "commandSignalListenerStartFailed",
            "Failed to start NATS bidding job command listener; DB polling remains active",
            toErrorLogFields(error),
        );
        return undefined;
    }
}

function createBiddingSdkClient(
    publicClient: PublicClient,
    policyWallet: OpenSeaPolicyWallet,
    rpcUrl: unknown,
    apiKey: string,
): OpenSeaBiddingSdkClient {
    const sdk = new OpenSeaSDK(
        {
            publicClient,
            walletClient: policyWallet.walletClient,
            // OpenSea types this as a string, but passes the runtime value into its provider bridge unchanged.
            rpcUrl: rpcUrl as string,
        },
        {
            chain: Chain.Mainnet,
            apiKey,
        },
        createOpenSeaSdkLogger("bidding"),
    );

    return {
        api: createApiClientAdapter(sdk.api),
        createOffer: async (
            input,
            authorization,
        ): Promise<OpenSeaCreateOfferResponse> =>
            await policyWallet.authorizeOffer(authorization, async () => {
                const order = await sdk.createOffer(input);
                return normalizeOfferResponse(order);
            }),
        createCollectionOffer: async (
            input,
            authorization,
        ): Promise<OpenSeaCreateCollectionOfferResponse | null> => {
            if (input.collectionSlug !== authorization.job.collectionSlug) {
                throw new Error(
                    "OpenSea collection-offer slug does not match the authorized bidding job",
                );
            }
            return await policyWallet.authorizeOffer(
                authorization,
                async () => {
                    const order = await sdk.createCollectionOffer(input);
                    return order ? normalizeOfferResponse(order) : null;
                },
            );
        },
        offchainCancelOrder: (
            protocolAddress,
            orderHash,
            chain,
            offererSignature,
            useSignerToDeriveOffererSignature,
        ) => {
            const cancel = () =>
                sdk.offchainCancelOrder(
                    protocolAddress,
                    orderHash,
                    chain as Chain,
                    offererSignature,
                    useSignerToDeriveOffererSignature,
                );
            return useSignerToDeriveOffererSignature
                ? policyWallet.authorizeOffchainCancellation(
                      protocolAddress,
                      orderHash,
                      cancel,
                  )
                : cancel();
        },
    };
}

function createTradingRpcObservability(
    metrics: Metrics,
    component: string,
): RpcObservability {
    return new RpcObservability({
        workspace: RPC_OBSERVABILITY_WORKSPACE.Trading,
        component,
        protocol: RPC_PROTOCOL.Http,
        metrics,
        logComponent: TRADING_RPC_LOG_COMPONENT,
    });
}

function assertConfiguredRpcEndpoints(
    endpoints: readonly { url: string }[],
): void {
    if (endpoints.length === 0) {
        throw new Error("Bidding runtime requires at least one RPC endpoint");
    }
}

function createSnapshotApiClient(apiKey: string): OpenSeaApiClient {
    const api = new OpenSeaAPI({
        apiKey,
        chain: Chain.Mainnet,
    });
    return createApiClientAdapter(api);
}

function createApiClientAdapter(api: OpenSeaAPI): OpenSeaApiClient {
    return {
        getOffersByNFT: (collectionSlug, tokenId, limit, next) =>
            api.getOffersByNFT(collectionSlug, tokenId, limit, next),
        getAllOffers: (collectionSlug, limit, next) =>
            api.getAllOffers(collectionSlug, limit, next),
        getOrderByHash: (orderHash, protocolAddress) =>
            api.getOrderByHash(orderHash, protocolAddress),
        getCollectionOffers: (collectionSlug, limit, next) =>
            api.getCollectionOffers(collectionSlug, limit, next),
        getTraitOffers: (collectionSlug, traitType, traitValue, limit, next) =>
            api.getTraitOffers(
                collectionSlug,
                traitType,
                traitValue,
                limit,
                next,
            ),
        getTraits: (collectionSlug) => api.getTraits(collectionSlug),
        getBestOffer: (collectionSlug, tokenId) =>
            api.getBestOffer(collectionSlug, tokenId),
    };
}

function normalizeOfferResponse(order: {
    orderHash?: string | null;
    order_hash?: string | null;
    protocolAddress?: string | null;
    protocol_address?: string | null;
    expirationTime?: number | string | null;
    expiration_time?: number | string | null;
    protocolData?: { parameters?: { endTime?: unknown } } | null;
    protocol_data?: { parameters?: { endTime?: unknown } } | null;
}): OpenSeaCreateOfferResponse {
    const expirationTime =
        normalizeNumberLike(order.expirationTime) ??
        normalizeNumberLike(order.protocolData?.parameters?.endTime) ??
        normalizeNumberLike(order.protocol_data?.parameters?.endTime);
    return {
        orderHash: order.orderHash ?? undefined,
        order_hash: order.order_hash ?? undefined,
        protocolAddress: order.protocolAddress ?? undefined,
        protocol_address: order.protocol_address ?? undefined,
        expirationTime,
        expiration_time: normalizeNumberLike(order.expiration_time),
    };
}

function normalizeNumberLike(value: unknown): number | string | undefined {
    if (typeof value === "number" || typeof value === "string") {
        return value;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    return undefined;
}

function createStreamClient(streamSecretKey: string): OpenSeaSdkStreamClient {
    return new OpenSeaSdkStreamClient({
        token: streamSecretKey,
        network: Network.MAINNET,
        logLevel: LogLevel.ERROR,
        // Route socket-level OpenSea stream errors through the bot logger instead of SDK console stderr.
        onError: (error) => {
            const formatted = formatOpenSeaStreamSocketError(error);
            log.warn(
                "openSeaStreamSocketError",
                "Socket error from OpenSea stream",
                formatted.meta,
            );
        },
    });
}

function createOpenSeaSdkLogger(lane: string): (line: string) => void {
    return (line: string) => {
        openSeaSdkLog.debug("sdkLog", "OpenSea SDK log line", { lane, line });
    };
}

function assertSupportedBiddingChain(chainId: number): void {
    if (chainId !== mainnet.id) {
        throw new Error(
            `Bidding runtime currently supports Ethereum mainnet only. received CHAIN_ID=${chainId}`,
        );
    }
}

function formatWeth(amountWei: bigint): string {
    return `${formatEther(amountWei)} WETH`;
}

// formatOpenSeaStreamSocketError keeps Phoenix/WebSocket ErrorEvent logs compact and JSON-safe.
export function formatOpenSeaStreamSocketError(error: unknown): {
    detail: string;
    meta: Record<string, unknown>;
} {
    if (error instanceof Error) {
        return {
            detail: `${error.name}: ${error.message}`,
            meta: {
                errorName: error.name,
                errorMessage: error.message,
            },
        };
    }

    if (isRecord(error)) {
        const constructorName = getConstructorName(error);
        const eventType = readStringProperty(error, "type");
        const eventMessage = readStringProperty(error, "message");
        const detailParts = [
            constructorName ? `constructor=${constructorName}` : null,
            eventType ? `type=${eventType}` : null,
            eventMessage ? `message=${eventMessage}` : null,
        ].filter((part): part is string => part !== null);

        return {
            detail:
                detailParts.length > 0
                    ? detailParts.join(", ")
                    : "non-error object",
            meta: compactMeta({
                errorConstructor: constructorName,
                errorType: eventType,
                errorMessage: eventMessage,
                defaultPrevented: readBooleanProperty(
                    error,
                    "defaultPrevented",
                ),
                cancelable: readBooleanProperty(error, "cancelable"),
                timeStamp: readNumberProperty(error, "timeStamp"),
            }),
        };
    }

    return {
        detail: String(error),
        meta: { errorValue: String(error) },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function getConstructorName(value: object): string | undefined {
    const constructorName = value.constructor?.name;
    return constructorName && constructorName !== "Object"
        ? constructorName
        : undefined;
}

function readStringProperty(
    value: Record<string, unknown>,
    key: string,
): string | undefined {
    const raw = value[key];
    return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function readBooleanProperty(
    value: Record<string, unknown>,
    key: string,
): boolean | undefined {
    const raw = value[key];
    return typeof raw === "boolean" ? raw : undefined;
}

function readNumberProperty(
    value: Record<string, unknown>,
    key: string,
): number | undefined {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function compactMeta(
    meta: Record<string, unknown | undefined>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(meta).filter(([, value]) => value !== undefined),
    );
}
