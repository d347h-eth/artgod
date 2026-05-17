import { setDbPath } from "@artgod/shared/database";
import {
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
} from "@artgod/shared/types";
import {
    LogLevel,
    Network,
    OpenSeaStreamClient as OpenSeaSdkStreamClient,
} from "@opensea/stream-js";
import { Chain, getDefaultConduit, OpenSeaAPI } from "@opensea/sdk";
import { OpenSeaSDK } from "@opensea/sdk/viem";
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { NatsBiddingJobCommandSignalListener } from "../adapters/jobs/nats-bidding-job-command-signal-listener.js";
import { SqliteBiddingBidBookProjection } from "../adapters/bid-book/sqlite-bidding-bid-book-projection.js";
import { SqliteBiddingJobCommandRepository } from "../adapters/jobs/sqlite-bidding-job-command-repository.js";
import { SqliteBiddingJobRuntimeState } from "../adapters/jobs/sqlite-bidding-job-runtime-state.js";
import { SqliteBiddingJobSource } from "../adapters/jobs/sqlite-bidding-job-source.js";
import { SqliteTokenMetadataRepository } from "../adapters/metadata/sqlite-token-metadata-repository.js";
import { OpenSeaBiddingService } from "../adapters/opensea/open-sea-bidding-service.js";
import { OpenSeaCollectionOfferSource } from "../adapters/opensea/open-sea-collection-offer-source.js";
import { OpenSeaEventStream } from "../adapters/opensea/open-sea-event-stream.js";
import { OpenSeaMarketEventFactory } from "../adapters/opensea/open-sea-market-event-factory.js";
import { SqliteTradingBotRuntimeState } from "../adapters/runtime/sqlite-trading-bot-runtime-state.js";
import { ViemWethAllowanceApprovalService } from "../adapters/wallet/viem-weth-allowance-approval-service.js";
import { ViemMakerWethBalanceService } from "../adapters/wallet/viem-maker-weth-balance-service.js";
import { Bidder } from "../application/use-cases/bidding/bidder.js";
import { BiddingBidBookProjectionScheduler } from "../application/use-cases/bidding/bidding-bid-book-projection.js";
import { BiddingJobCommandReconciler } from "../application/use-cases/bidding/bidding-job-command-reconciler.js";
import { CollectionOfferSnapshotService } from "../application/use-cases/bidding/collection-offer-snapshot-service.js";
import { AttrFilter } from "../application/use-cases/market/pipeline/lib/attr-filter.js";
import { BidderRefresh } from "../application/use-cases/market/pipeline/lib/bidder-refresh.js";
import { CollectionOfferSnapshotRefresh } from "../application/use-cases/market/pipeline/lib/collection-offer-snapshot-refresh.js";
import { PipelineBuilder } from "../application/use-cases/market/pipeline/pipeline.js";
import { StreamListener } from "../application/use-cases/stream/stream-listener.js";
import {
    EnabledBiddingConfig,
    TradingConfig,
} from "../config/trading-config.js";
import { MarketEvent, Type } from "../domain/market/event.js";
import { BidderJob } from "../domain/market/strategy/job.js";
import { biddingLog } from "../utils/bidding-log.js";
import { startBiddingCommandReconciliationLoop } from "./bidding-command-reconciliation-loop.js";
import type {
    OpenSeaApiClient,
    OpenSeaBiddingSdkClient,
    OpenSeaCreateCollectionOfferResponse,
    OpenSeaCreateOfferResponse,
} from "../adapters/opensea/open-sea-client.js";

type BiddingRuntimeHandle = {
    shutdown(): Promise<void>;
};

type StartBiddingRuntimeParams = {
    config: TradingConfig;
    biddingConfig: EnabledBiddingConfig;
    privateKeyHex: Hex;
    makerAddress: string;
    walletId: string;
    lifecycle: BiddingRuntimeLifecyclePort;
};

type RegisteredBidStream = {
    collectionSlug: string;
    stream: OpenSeaEventStream;
    listener: StreamListener;
};

export interface BiddingRuntimeLifecyclePort {
    bootstrapping(update: BiddingRuntimeBootstrapLifecycleUpdate): void;
    progress(update: BiddingRuntimeBootstrapLifecycleUpdate): void;
}

export type BiddingRuntimeBootstrapPhase =
    | "allowance_approval"
    | "snapshot_bootstrap"
    | "price_bootstrap";

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
    assertSupportedBiddingChain(params.config.chainId);

    // Point the shared SQLite helpers at the runtime-selected ArtGod database before metadata adapters start reading.
    setDbPath(params.config.dbPath);

    const runtimeStateIdentity = {
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: params.config.chainId,
        walletId: params.walletId,
        address: params.makerAddress,
    };
    const runtimeState = new SqliteTradingBotRuntimeState();
    // Publish a bootstrapping heartbeat so backend readers can see the bot process is alive but not snapshot-ready.
    runtimeState.startHeartbeat(
        runtimeStateIdentity,
        TRADING_BOT_RUNTIME_STATE.Bootstrapping,
    );

    const biddingJobSource = new SqliteBiddingJobSource(params.config.chainId);
    // Load the authoritative enabled bidding jobs from SQLite before creating any market-facing adapters.
    biddingLog.info(
        `[BiddingRuntime] Loading bidding jobs from SQLite. dbPath=${params.config.dbPath}, chainId=${params.config.chainId}`,
    );
    const jobs = await biddingJobSource.loadEnabledJobs();
    const watchedCollectionSlugs = collectWatchedCollectionSlugs(jobs);
    const snapshotBackedCollectionSlugs =
        collectSnapshotBackedCollectionSlugs(jobs);
    const tokenWarmCandidates = collectTokenWarmCandidateCount(jobs);
    biddingLog.info(
        `[BiddingRuntime] Loaded bidding jobs. jobs=${jobs.length}, watchedCollections=${watchedCollectionSlugs.length}, snapshotBackedCollections=${snapshotBackedCollectionSlugs.length}, tokenWarmCandidates=${tokenWarmCandidates}`,
    );

    const tokenMetadataRepository = new SqliteTokenMetadataRepository(
        params.config.chainId,
    );
    const publicClient = createPublicClient({
        chain: mainnet,
        transport: http(params.config.rpc.primaryUrl),
    });
    const makerWethBalanceService = new ViemMakerWethBalanceService(
        publicClient,
        params.config.tokens.wethAddress,
    );
    const walletClient = createWalletClient({
        account: privateKeyToAccount(params.privateKeyHex),
        chain: mainnet,
        transport: http(params.config.rpc.primaryUrl),
    });
    const openSeaConduit = getDefaultConduit(Chain.Mainnet);
    const wethAllowanceApprovalService = new ViemWethAllowanceApprovalService(
        publicClient,
        walletClient,
        params.config.tokens.wethAddress,
        openSeaConduit.address,
        params.biddingConfig.transactionPolicy,
    );

    const allowanceApprovalTotal =
        params.biddingConfig.wethAllowanceWei > 0n ? 1 : 0;
    const reportAllowanceProgress = (detail: string): void => {
        params.lifecycle.progress({
            phase: "allowance_approval",
            completed: 0,
            total: allowanceApprovalTotal,
            detail,
        });
    };
    // Tell the supervisor the runtime is live before any startup approval transaction can block.
    params.lifecycle.bootstrapping({
        phase: "allowance_approval",
        completed: 0,
        total: allowanceApprovalTotal,
        detail: `desired=${formatWeth(params.biddingConfig.wethAllowanceWei)}, conduit=${openSeaConduit.address}`,
    });
    // Ensure the maker grants the static WETH allowance configured for OpenSea bidding.
    const allowanceResult = await wethAllowanceApprovalService.ensureAllowance({
        ownerAddress: params.makerAddress,
        desiredAllowanceWei: params.biddingConfig.wethAllowanceWei,
        dryRun: params.biddingConfig.dryRun,
        onProgress: reportAllowanceProgress,
    });
    params.lifecycle.progress({
        phase: "allowance_approval",
        completed: allowanceApprovalTotal,
        total: allowanceApprovalTotal,
        detail: `status=${allowanceResult.status}, desired=${formatWeth(allowanceResult.desiredAllowanceWei)}, current=${formatOptionalWeth(allowanceResult.currentAllowanceWei)}`,
    });
    biddingLog.info(
        `[BiddingRuntime] Allowance approval bootstrap complete. status=${allowanceResult.status}, desired=${formatWeth(allowanceResult.desiredAllowanceWei)}, current=${formatOptionalWeth(allowanceResult.currentAllowanceWei)}`,
    );

    // Create the write-capable OpenSea SDK lane for live offer discovery, placement, and cancellation.
    const biddingSdk = createBiddingSdkClient(
        publicClient,
        walletClient,
        params.config.rpc.primaryUrl,
        params.biddingConfig.openSea.biddingSecretKey,
    );
    const bidBookProjection = new BiddingBidBookProjectionScheduler(
        new SqliteBiddingBidBookProjection(
            params.config.chainId,
            params.makerAddress,
            params.config.tokens.wethAddress,
        ),
        params.biddingConfig.bidBookProjectionThrottleMs,
    );
    const collectionOfferSnapshotService = new CollectionOfferSnapshotService(
        // Create the dedicated snapshot API lane so polling never shares the bidding key or limiter.
        new OpenSeaCollectionOfferSource(
            createSnapshotApiClient(
                params.biddingConfig.openSea.snapshotSecretKey,
            ),
        ),
        snapshotBackedCollectionSlugs,
        params.biddingConfig.collectionOffersPollMs,
        params.biddingConfig.collectionOffersTtlMs,
        {
            onSnapshotRefreshed: (snapshot, reason) => {
                bidBookProjection.requestProjection(snapshot, reason);
            },
        },
    );

    const biddingService = new OpenSeaBiddingService(
        biddingSdk,
        params.makerAddress,
        {
            collectionOfferSnapshotProvider: collectionOfferSnapshotService,
            tokenMetadataRepository,
            offerExpirationSeconds: params.biddingConfig.offerExpirationSeconds,
            orderLookupMaxPages: params.biddingConfig.orderLookupMaxPages,
            tokenCriteriaTraitsByCollection:
                params.biddingConfig.tokenCriteriaTraitsByCollection,
        },
    );
    const bidder = new Bidder(
        biddingService,
        params.makerAddress,
        params.biddingConfig.pollMs,
        {
            dryRun: params.biddingConfig.dryRun,
            maxConcurrentJobs: params.biddingConfig.maxConcurrentJobs,
            bootstrapConcurrency: params.biddingConfig.bootstrapConcurrency,
        },
        tokenMetadataRepository,
        makerWethBalanceService,
        new SqliteBiddingJobRuntimeState(),
    );

    // Register all configured jobs before bootstrapping snapshot state or current prices.
    jobs.forEach((job) => bidder.addJob(job));

    if (snapshotBackedCollectionSlugs.length > 0) {
        // Tell the supervisor the runtime is live and entering the authoritative snapshot bootstrap phase.
        params.lifecycle.bootstrapping({
            phase: "snapshot_bootstrap",
            completed: 0,
            total: snapshotBackedCollectionSlugs.length,
            detail: `collections=${snapshotBackedCollectionSlugs.length}, tokenWarmCandidates=${tokenWarmCandidates}`,
        });
        // Build the authoritative collection snapshots before the bidder starts reacting to live stream signals.
        await collectionOfferSnapshotService.bootstrap({
            onProgress: ({ collectionSlug, completed, total }) => {
                params.lifecycle.progress({
                    phase: "snapshot_bootstrap",
                    completed,
                    total,
                    detail: `collection=${collectionSlug}`,
                });
            },
        });
    }

    // Tell the supervisor the runtime is still healthy while current-price warmup is running for token jobs.
    params.lifecycle.bootstrapping({
        phase: "price_bootstrap",
        completed: 0,
        total: tokenWarmCandidates,
        detail: `snapshotCollections=${snapshotBackedCollectionSlugs.length}, tokenWarmCandidates=${tokenWarmCandidates}`,
    });
    // Warm token-job current prices so the first bidder loop starts from real market context.
    await bidder.bootstrapCurrentPrices({
        onProgress: ({ jobId, completed, total, warmed }) => {
            params.lifecycle.progress({
                phase: "price_bootstrap",
                completed,
                total,
                detail: `jobId=${jobId}, warmed=${warmed}`,
            });
        },
    });

    const streamClient = createStreamClient(
        params.biddingConfig.openSea.streamSecretKey,
    );
    const bidPipeline = buildBidPipeline(
        params.makerAddress,
        bidder,
        collectionOfferSnapshotService,
        params.biddingConfig.criteriaRefreshTraitsByCollection,
    );
    const bidStreams = new Map<string, RegisteredBidStream>();
    const ensureBidStream = (collectionSlug: string): boolean => {
        if (bidStreams.has(collectionSlug)) {
            return false;
        }

        // Subscribe the direct OpenSea bid stream when a DB-driven job introduces a watched collection.
        bidStreams.set(
            collectionSlug,
            registerBidStream(streamClient, collectionSlug, bidPipeline),
        );
        biddingLog.info(
            `[BiddingRuntime] Subscribed direct OpenSea bid stream for ${collectionSlug}. streamCollections=${bidStreams.size}`,
        );
        return true;
    };
    const disposeBidStream = (collectionSlug: string): boolean => {
        const registered = bidStreams.get(collectionSlug);
        if (!registered) {
            return false;
        }

        // Unsubscribe the direct OpenSea bid stream once no enabled job needs this collection.
        registered.stream.dispose();
        bidStreams.delete(collectionSlug);
        biddingLog.info(
            `[BiddingRuntime] Unsubscribed direct OpenSea bid stream for ${collectionSlug}. streamCollections=${bidStreams.size}`,
        );
        return true;
    };
    const reconcileBidStreams = (collectionSlugs: string[]): {
        added: number;
        removed: number;
    } => {
        const next = new Set(collectionSlugs);
        let added = 0;
        let removed = 0;

        for (const collectionSlug of Array.from(bidStreams.keys())) {
            if (!next.has(collectionSlug) && disposeBidStream(collectionSlug)) {
                removed += 1;
            }
        }

        for (const collectionSlug of next) {
            if (ensureBidStream(collectionSlug)) {
                added += 1;
            }
        }

        return { added, removed };
    };
    watchedCollectionSlugs.forEach(ensureBidStream);

    // Start the steady-state snapshot polling only after bootstrap completed successfully.
    collectionOfferSnapshotService.start();

    const commandRepository = new SqliteBiddingJobCommandRepository();
    const commandReconciler = new BiddingJobCommandReconciler(
        commandRepository,
        biddingJobSource,
        bidder,
        {
            prepareEnabledJob: async (job) => {
                ensureBidStream(job.collectionSlug);
                if (
                    job.target.type === "token" ||
                    job.target.type === "collection"
                ) {
                    collectionOfferSnapshotService.watchCollection(
                        job.collectionSlug,
                    );
                    // Refresh the authoritative snapshot before the reconciled job performs an immediate bid pass.
                    await collectionOfferSnapshotService.refreshAndWait(
                        job.collectionSlug,
                        `job command reconciliation: ${job.id}`,
                        { respectTtl: true },
                    );
                }
            },
            reconcileEnabledJobs: async (enabledJobs) => {
                const nextStreamCollections =
                    collectWatchedCollectionSlugs(enabledJobs);
                reconcileBidStreams(nextStreamCollections);
                const nextSnapshotCollections =
                    collectSnapshotBackedCollectionSlugs(enabledJobs);
                collectionOfferSnapshotService.reconcileWatchedCollections(
                    nextSnapshotCollections,
                );
            },
        },
        {
            batchSize: params.biddingConfig.commandBatchSize,
            claimTimeoutMs: params.biddingConfig.commandClaimTimeoutMs,
            maxAttempts: params.biddingConfig.commandMaxAttempts,
        },
    );
    // Process any committed DB commands before the normal bidder loop starts.
    await commandReconciler.processPendingCommands("startup");

    // Start the steady-state bidder tick loop only after stream listeners and warm state are ready.
    bidder.start();

    const commandLoop = startBiddingCommandReconciliationLoop(
        commandReconciler,
        params.biddingConfig.commandPollMs,
    );
    const signalListener = await startBiddingJobCommandSignalListener(
        params.config.queue.natsUrl,
        params.config.queue.streamPrefix,
        commandReconciler,
    );

    biddingLog.info(
        `[BiddingRuntime] Started bidder with ${jobs.length} job(s), watchedCollections=${watchedCollectionSlugs.length}, snapshotCollections=${snapshotBackedCollectionSlugs.length}, dryRun=${params.biddingConfig.dryRun}`,
    );
    // Switch to running heartbeat only after bootstrap and steady-state loops have started.
    runtimeState.startHeartbeat(
        runtimeStateIdentity,
        TRADING_BOT_RUNTIME_STATE.Running,
    );

    return {
        async shutdown(): Promise<void> {
            try {
                bidder.stop();
                bidBookProjection.stop();
                collectionOfferSnapshotService.stop();
                await commandLoop.shutdown();
                await signalListener?.shutdown();
                bidStreams.forEach(({ stream }) => stream.dispose());
                bidStreams.clear();
                // Disconnect the shared OpenSea socket after all per-collection handlers were removed.
                streamClient.disconnect();
            } finally {
                runtimeState.stopHeartbeat();
                // Mark the bot stopped so backend reads fall back to indexed orders immediately.
                runtimeState.markState(
                    runtimeStateIdentity,
                    TRADING_BOT_RUNTIME_STATE.Stopped,
                );
            }
        },
    };
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
                        job.target.type === "token" ||
                        job.target.type === "collection",
                )
                .map((job) => job.collectionSlug),
        ),
    );
}

// collectTokenWarmCandidateCount approximates the size of the current-price bootstrap pass before runtime state exists.
export function collectTokenWarmCandidateCount(jobs: BidderJob[]): number {
    return jobs.filter((job) => job.target.type === "token").length;
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
) {
    const opponentBidsFilter = new AttrFilter("opponent-bids");
    opponentBidsFilter.addCriteria("opponent-only", (marketEvent) => {
        return (
            marketEvent.getMaker().toLowerCase() !== makerAddress.toLowerCase()
        );
    });

    const pipelineBuilder = new PipelineBuilder().with(opponentBidsFilter);
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
    return pipelineBuilder.build();
}

function registerBidStream(
    streamClient: OpenSeaSdkStreamClient,
    collectionSlug: string,
    bidPipeline: Parameters<StreamListener["attachHandler"]>[1],
): RegisteredBidStream {
    // Subscribe the direct OpenSea bid stream for each watched collection.
    const stream = new OpenSeaEventStream(
        streamClient,
        collectionSlug,
        new OpenSeaMarketEventFactory(),
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
            await commandReconciler.processPendingCommands("nats");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        biddingLog.warn(
            `[BiddingRuntime] Failed to start NATS bidding job command listener; DB polling remains active. error=${message}`,
        );
        return undefined;
    }
}

function createBiddingSdkClient(
    publicClient: PublicClient,
    walletClient: WalletClient,
    rpcUrl: string,
    apiKey: string,
): OpenSeaBiddingSdkClient {
    const sdk = new OpenSeaSDK(
        {
            publicClient,
            walletClient,
            rpcUrl,
        },
        {
            chain: Chain.Mainnet,
            apiKey,
        },
        createOpenSeaSdkLogger("bidding"),
    );

    return {
        api: createApiClientAdapter(sdk.api),
        createOffer: async (input): Promise<OpenSeaCreateOfferResponse> => {
            const order = await sdk.createOffer(input);
            return normalizeOfferResponse(order);
        },
        createCollectionOffer: async (
            input,
        ): Promise<OpenSeaCreateCollectionOfferResponse | null> => {
            const order = await sdk.createCollectionOffer(input);
            return order ? normalizeOfferResponse(order) : null;
        },
        offchainCancelOrder: (
            protocolAddress,
            orderHash,
            chain,
            offererSignature,
            useSignerToDeriveOffererSignature,
        ) =>
            sdk.offchainCancelOrder(
                protocolAddress,
                orderHash,
                chain as Chain,
                offererSignature,
                useSignerToDeriveOffererSignature,
            ),
    };
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
            biddingLog.warn(
                `[OpenSeaStream] Socket error from OpenSea stream. ${formatted.detail}`,
                formatted.meta,
            );
        },
    });
}

function createOpenSeaSdkLogger(lane: string): (line: string) => void {
    return (line: string) => {
        biddingLog.debug(`[OpenSeaSDK:${lane}] ${line}`);
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

function formatOptionalWeth(amountWei: bigint | null): string {
    return amountWei === null ? "n/a" : formatWeth(amountWei);
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
