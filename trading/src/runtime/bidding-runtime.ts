import { setDbPath } from "@artgod/shared/database";
import { LogLevel, Network, OpenSeaStreamClient as OpenSeaSdkStreamClient } from "@opensea/stream-js";
import { JsonRpcProvider, Wallet } from "ethers";
import { Chain, OpenSeaSDK, OrderSide } from "opensea-js";
import { OpenSeaAPI } from "opensea-js/lib/api/api.js";
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { loadBiddingJobsFromFile } from "../adapters/config/bidding-jobs-file.js";
import { SqliteTokenMetadataRepository } from "../adapters/metadata/sqlite-token-metadata-repository.js";
import { OpenSeaBiddingService } from "../adapters/opensea/open-sea-bidding-service.js";
import { OpenSeaCollectionOfferSource } from "../adapters/opensea/open-sea-collection-offer-source.js";
import { OpenSeaEventStream } from "../adapters/opensea/open-sea-event-stream.js";
import { OpenSeaMarketEventFactory } from "../adapters/opensea/open-sea-market-event-factory.js";
import { ViemMakerWethBalanceService } from "../adapters/wallet/viem-maker-weth-balance-service.js";
import { Bidder } from "../application/use-cases/bidding/bidder.js";
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
    lifecycle: BiddingRuntimeLifecyclePort;
};

type RegisteredBidStream = {
    collectionSlug: string;
    stream: OpenSeaEventStream;
    listener: StreamListener;
};

export interface BiddingRuntimeLifecyclePort {
    bootstrapping(
        update: BiddingRuntimeBootstrapLifecycleUpdate,
    ): void;
    progress(update: BiddingRuntimeBootstrapLifecycleUpdate): void;
}

export interface BiddingRuntimeBootstrapLifecycleUpdate {
    phase: "snapshot_bootstrap" | "price_bootstrap";
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

    // Load operator-managed bidding jobs before creating any market-facing adapters.
    const jobs = await loadBiddingJobsFromFile(params.biddingConfig.jobsFile);
    const watchedCollectionSlugs = collectWatchedCollectionSlugs(jobs);
    const snapshotBackedCollectionSlugs =
        collectSnapshotBackedCollectionSlugs(jobs);
    const tokenWarmCandidates = collectTokenWarmCandidateCount(jobs);

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

    // Create the write-capable OpenSea SDK lane for live offer discovery, placement, and cancellation.
    const biddingSdk = createBiddingSdkClient(
        params.privateKeyHex,
        params.config.rpc.primaryUrl,
        params.biddingConfig.openSea.biddingSecretKey,
    );
    const collectionOfferSnapshotService =
        snapshotBackedCollectionSlugs.length > 0
            ? new CollectionOfferSnapshotService(
                  // Create the dedicated snapshot API lane so polling never shares the bidding key or limiter.
                  new OpenSeaCollectionOfferSource(
                      createSnapshotApiClient(
                          params.biddingConfig.openSea.snapshotSecretKey,
                      ),
                  ),
                  snapshotBackedCollectionSlugs,
                  params.biddingConfig.collectionOffersPollMs,
                  params.biddingConfig.collectionOffersTtlMs,
              )
            : undefined;

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
    );

    // Register all configured jobs before bootstrapping snapshot state or current prices.
    jobs.forEach((job) => bidder.addJob(job));

    if (collectionOfferSnapshotService) {
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

    const streamClient =
        watchedCollectionSlugs.length > 0
            ? createStreamClient(params.biddingConfig.openSea.streamSecretKey)
            : undefined;
    const bidStreams =
        streamClient !== undefined
            ? registerBidStreams(
                  streamClient,
                  watchedCollectionSlugs,
                  buildBidPipeline(
                      params.makerAddress,
                      bidder,
                      collectionOfferSnapshotService,
                      params.biddingConfig.criteriaRefreshTraitsByCollection,
                  ),
              )
            : [];

    if (collectionOfferSnapshotService) {
        // Start the steady-state snapshot polling only after bootstrap completed successfully.
        collectionOfferSnapshotService.start();
    }

    // Start the steady-state bidder tick loop only after stream listeners and warm state are ready.
    bidder.start();

    biddingLog.info(
        `[BiddingRuntime] Started bidder with ${jobs.length} job(s), watchedCollections=${watchedCollectionSlugs.length}, snapshotCollections=${snapshotBackedCollectionSlugs.length}, dryRun=${params.biddingConfig.dryRun}`,
    );

    return {
        async shutdown(): Promise<void> {
            bidder.stop();
            collectionOfferSnapshotService?.stop();
            bidStreams.forEach(({ stream }) => stream.dispose());
            // Disconnect the shared OpenSea socket after all per-collection handlers were removed.
            streamClient?.disconnect();
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
        return marketEvent.getMaker().toLowerCase() !== makerAddress.toLowerCase();
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

function registerBidStreams(
    streamClient: OpenSeaSdkStreamClient,
    watchedCollectionSlugs: string[],
    bidPipeline: Parameters<StreamListener["attachHandler"]>[1],
): RegisteredBidStream[] {
    return watchedCollectionSlugs.map((collectionSlug) => {
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
    });
}

function createBiddingSdkClient(
    privateKeyHex: Hex,
    rpcUrl: string,
    apiKey: string,
): OpenSeaBiddingSdkClient {
    const provider = new JsonRpcProvider(rpcUrl);
    // The public opensea-js v8 SDK still expects ethers-native signer types on this boundary.
    const signer = new Wallet(privateKeyHex, provider) as any;
    const sdk = new OpenSeaSDK(
        signer,
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
        getOrders: (query) =>
            api.getOrders({
                ...query,
                side: query.side as OrderSide,
            } as any),
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
}): OpenSeaCreateOfferResponse {
    return {
        orderHash: order.orderHash ?? undefined,
        order_hash: order.order_hash ?? undefined,
        protocolAddress: order.protocolAddress ?? undefined,
        protocol_address: order.protocol_address ?? undefined,
        expirationTime: order.expirationTime ?? undefined,
        expiration_time: order.expiration_time ?? undefined,
    };
}

function createStreamClient(streamSecretKey: string): OpenSeaSdkStreamClient {
    return new OpenSeaSdkStreamClient({
        token: streamSecretKey,
        network: Network.MAINNET,
        logLevel: LogLevel.ERROR,
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
