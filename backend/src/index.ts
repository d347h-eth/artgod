import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import {
    SqliteActivitiesReadModel,
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import { CreateBootstrapRunUseCase } from "./application/use-cases/bootstrap/create-bootstrap-run.js";
import { GetBootstrapRunDetailUseCase } from "./application/use-cases/bootstrap/get-bootstrap-run-detail.js";
import { GetBootstrapStatusUseCase } from "./application/use-cases/bootstrap/get-bootstrap-status.js";
import { ListBootstrapRunsUseCase } from "./application/use-cases/bootstrap/list-bootstrap-runs.js";
import { RetryBootstrapRunFailedTasksUseCase } from "./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js";
import { logger } from "@artgod/shared/utils";
import { GetDefaultChainUseCase } from "./application/use-cases/chains/get-default-chain.js";
import { GetCollectionActivityUseCase } from "./application/use-cases/activities/get-collection-activity.js";
import { GetTokenActivityUseCase } from "./application/use-cases/activities/get-token-activity.js";
import { GetCollectionCustomizationUseCase } from "./application/use-cases/collections/get-collection-customization.js";
import {
    CachedGetTokenPreview,
    type TokenPreviewWarmupPort,
} from "./application/use-cases/collections/cached-get-token-preview.js";
import {
    PublicCollectionDetailCache,
    isCollectionDetailDefaultQueryCacheEligible,
} from "./application/use-cases/collections/cached-get-collection-detail.js";
import {
    GetCollectionDetailUseCase,
    type GetCollectionDetailInput,
    type GetCollectionDetailPort,
} from "./application/use-cases/collections/get-collection-detail.js";
import { GetCollectionHoldersUseCase } from "./application/use-cases/collections/get-collection-holders.js";
import { GetTokenDetailUseCase } from "./application/use-cases/collections/get-token-detail.js";
import {
    GetTokenPreviewUseCase,
    type GetTokenPreviewPort,
} from "./application/use-cases/collections/get-token-preview.js";
import { UpdateCollectionCustomizationUseCase } from "./application/use-cases/collections/update-collection-customization.js";
import { ListCollectionsUseCase } from "./application/use-cases/collections/list-collections.js";
import { GetRuntimeHealthUseCase } from "./application/use-cases/health/get-runtime-health.js";
import { ResolveOwnerRefUseCase } from "./application/use-cases/owners/resolve-owner-ref.js";
import type { BackendConfig } from "./config.js";
import { loadBackendConfig } from "./config.js";
import { createApiApp } from "./http-app.js";
import { NatsBootstrapCommandQueue } from "./infra/bootstrap/nats-bootstrap-command-queue.js";
import { MemoryQueryCache } from "./infra/cache/memory.js";
import { SqliteBootstrapRunsRepository } from "./infra/bootstrap/sqlite-bootstrap-runs.js";
import { ExtensionAwareCollectionCustomization } from "./infra/collections/extension-aware-collection-customization.js";
import { ExtensionAwareCollectionDetailRead } from "./infra/collections/extension-aware-collection-detail-read.js";
import { SqliteCollectionCustomizationRecords } from "./infra/collections/sqlite-collection-customization-records.js";
import { SqliteCollectionExtensionRecords } from "./infra/collections/sqlite-collection-extension-records.js";
import { NatsRuntimeHealthAdapter } from "./infra/runtime-health/nats-runtime-health.js";
import { SqliteRuntimeHealthAdapter } from "./infra/runtime-health/sqlite-runtime-health.js";
import { ViemBackendRpcClient } from "./infra/rpc/viem-backend-rpc.js";
import {
    QUERY_CACHE_PROVIDERS,
    type QueryCachePort,
} from "./ports/query-cache.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function startBackendServer(
    config: BackendConfig,
): Promise<FastifyInstance> {
    setDbPath(config.dbPath);
    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();

    const app = createBackendApp(config);
    await app.listen({
        port: config.port,
        host: config.host,
    });
    return app;
}

export function createBackendApp(config: BackendConfig): FastifyInstance {
    const chainsReadModel = new SqliteChainsReadModel();
    const collectionsReadModel = new SqliteCollectionsReadModel([
        ZERO_ADDRESS,
        config.wethAddress,
    ]);
    const activitiesReadModel = new SqliteActivitiesReadModel();
    const backendRpcClient = new ViemBackendRpcClient(config.rpcUrl);
    const collectionExtensionRecords = new SqliteCollectionExtensionRecords();
    const collectionCustomizationRecords =
        new SqliteCollectionCustomizationRecords();
    const extensionAwareCollectionsReadModel =
        new ExtensionAwareCollectionDetailRead(
            collectionsReadModel,
            collectionExtensionRecords,
        );
    const extensionAwareCollectionCustomization =
        new ExtensionAwareCollectionCustomization(
            collectionExtensionRecords,
            collectionCustomizationRecords,
        );
    const bootstrapRunsRepository = new SqliteBootstrapRunsRepository();
    const bootstrapCommandQueue = new NatsBootstrapCommandQueue(
        config.natsUrl,
        config.natsStreamPrefix,
    );
    const createBootstrapRunUseCase = new CreateBootstrapRunUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
        bootstrapCommandQueue,
    );
    const getBootstrapStatusUseCase = new GetBootstrapStatusUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
    );
    const listBootstrapRunsUseCase = new ListBootstrapRunsUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
    );
    const getBootstrapRunDetailUseCase = new GetBootstrapRunDetailUseCase(
        config.defaultChainId,
        chainsReadModel,
        bootstrapRunsRepository,
    );
    const retryBootstrapRunFailedTasksUseCase =
        new RetryBootstrapRunFailedTasksUseCase(
            config.defaultChainId,
            chainsReadModel,
            bootstrapRunsRepository,
            bootstrapCommandQueue,
        );
    const getDefaultChainUseCase = new GetDefaultChainUseCase(
        config.defaultChainId,
        chainsReadModel,
    );
    const listCollectionsUseCase = new ListCollectionsUseCase(
        config.defaultChainId,
        chainsReadModel,
        collectionsReadModel,
    );
    const resolveOwnerRefUseCase = new ResolveOwnerRefUseCase(
        config.defaultChainId,
        chainsReadModel,
        backendRpcClient,
    );
    const getCollectionDetailUseCase = new GetCollectionDetailUseCase(
        config.defaultChainId,
        chainsReadModel,
        extensionAwareCollectionsReadModel,
        extensionAwareCollectionCustomization,
    );
    const getTokenPreviewUseCase = new GetTokenPreviewUseCase(
        config.defaultChainId,
        chainsReadModel,
        extensionAwareCollectionsReadModel,
    );
    const tokenPreview = maybeCreateCachedGetTokenPreviewPort(
        config,
        getTokenPreviewUseCase,
    );
    const collectionDetail = maybeCreateCollectionDetailPort(
        config,
        getCollectionDetailUseCase,
        createPublicCollectionDefaultMediaModePort(
            config,
            chainsReadModel,
            extensionAwareCollectionsReadModel,
        ),
        tokenPreview.warmup,
    );
    const getCollectionActivityUseCase = new GetCollectionActivityUseCase(
        config.defaultChainId,
        chainsReadModel,
        extensionAwareCollectionsReadModel,
        activitiesReadModel,
        extensionAwareCollectionsReadModel,
        extensionAwareCollectionCustomization,
    );
    const getCollectionCustomizationUseCase =
        new GetCollectionCustomizationUseCase(
            config.defaultChainId,
            chainsReadModel,
            extensionAwareCollectionsReadModel,
            extensionAwareCollectionCustomization,
        );
    const getCollectionHoldersUseCase = new GetCollectionHoldersUseCase(
        config.defaultChainId,
        chainsReadModel,
        extensionAwareCollectionsReadModel,
    );
    const getTokenDetailUseCase = new GetTokenDetailUseCase(
        config.defaultChainId,
        chainsReadModel,
        extensionAwareCollectionsReadModel,
        extensionAwareCollectionCustomization,
    );
    const getTokenActivityUseCase = new GetTokenActivityUseCase(
        config.defaultChainId,
        chainsReadModel,
        extensionAwareCollectionsReadModel,
        activitiesReadModel,
        extensionAwareCollectionsReadModel,
        extensionAwareCollectionCustomization,
    );
    const updateCollectionCustomizationUseCase =
        new UpdateCollectionCustomizationUseCase(
            config.defaultChainId,
            chainsReadModel,
            extensionAwareCollectionsReadModel,
            extensionAwareCollectionCustomization,
        );
    const runtimeHealthUseCase = new GetRuntimeHealthUseCase(
        new SqliteRuntimeHealthAdapter(),
        new NatsRuntimeHealthAdapter(config.natsUrl),
        `${config.natsStreamPrefix}-jobs`,
    );
    const app = createApiApp(
        createBootstrapRunUseCase,
        listBootstrapRunsUseCase,
        getBootstrapRunDetailUseCase,
        getBootstrapStatusUseCase,
        retryBootstrapRunFailedTasksUseCase,
        getDefaultChainUseCase,
        listCollectionsUseCase,
        resolveOwnerRefUseCase,
        getCollectionActivityUseCase,
        getTokenActivityUseCase,
        getCollectionCustomizationUseCase,
        collectionDetail.port,
        getCollectionHoldersUseCase,
        getTokenDetailUseCase,
        tokenPreview.port,
        updateCollectionCustomizationUseCase,
        runtimeHealthUseCase,
        config.userlandUiDistDir,
        config.security,
        config.deployment,
    );
    collectionDetail.lifecycle?.start();
    app.addHook("onClose", async () => {
        collectionDetail.lifecycle?.stop();
    });
    return app;
}

function maybeCreateCollectionDetailPort(
    config: BackendConfig,
    port: GetCollectionDetailPort,
    defaultMediaModePort: { getDefaultMediaMode(): string | Promise<string> },
    tokenPreviewWarmupPort: TokenPreviewWarmupPort | null,
): {
    port: GetCollectionDetailPort;
    lifecycle: PublicCollectionDetailCache | null;
} {
    if (
        config.deployment.mode !== "public_single_collection" ||
        !config.deployment.publicCollectionScope ||
        config.queryCache.provider === QUERY_CACHE_PROVIDERS.Disabled
    ) {
        return {
            port,
            lifecycle: null,
        };
    }

    const cachedPort = new PublicCollectionDetailCache(
        port,
        defaultMediaModePort,
        tokenPreviewWarmupPort,
        {
            defaultInput: createPublicCollectionDetailCacheInput(
                config.deployment.publicCollectionScope,
            ),
            refreshMs: config.queryCache.publicCollection.detailRefreshMs,
            previewWarmRefreshMs:
                config.queryCache.publicCollection.previewWarmRefreshMs,
        },
    );

    return {
        port: cachedPort,
        lifecycle: cachedPort,
    };
}

function maybeCreateCachedGetTokenPreviewPort(
    config: BackendConfig,
    port: GetTokenPreviewPort,
): {
    port: GetTokenPreviewPort;
    warmup: TokenPreviewWarmupPort | null;
} {
    const cache = createQueryCache(
        config.queryCache.provider,
        config.queryCache.tokenPreview.maxEntries,
    );
    if (
        config.deployment.mode !== "public_single_collection" ||
        !cache
    ) {
        return {
            port,
            warmup: null,
        };
    }

    const cachedPort = new CachedGetTokenPreview(cache, port, {
        freshMs: config.queryCache.tokenPreview.freshMs,
        staleMs: config.queryCache.tokenPreview.staleMs,
        warmupConcurrency: config.queryCache.tokenPreview.warmupConcurrency,
    });

    return {
        port: cachedPort,
        warmup: cachedPort,
    };
}

function createQueryCache(
    provider: BackendConfig["queryCache"]["provider"],
    maxEntries: number,
): QueryCachePort | null {
    if (provider === QUERY_CACHE_PROVIDERS.Disabled) {
        return null;
    }
    if (provider === QUERY_CACHE_PROVIDERS.Memory) {
        return new MemoryQueryCache({
            maxEntries,
        });
    }
    throw new Error(`Unsupported BACKEND_QUERY_CACHE_PROVIDER: ${provider}`);
}

function createPublicCollectionDefaultMediaModePort(
    config: BackendConfig,
    chainRefResolverPort: {
        resolveChainRef(
            chainRef: string | undefined,
            defaultPublicChainId: number,
        ): { publicChainId: number };
    },
    collectionDetailReadPort: {
        resolveCollectionRef(
            chainId: number,
            collectionRef: string,
        ): { collectionId: number };
        getCollectionMediaState(params: {
            chainId: number;
            collectionId: number;
            mediaMode?: string;
        }): { defaultMode: string };
    },
): { getDefaultMediaMode(): string } {
    return {
        getDefaultMediaMode(): string {
            const scope = config.deployment.publicCollectionScope;
            if (!scope) {
                throw new Error("Missing public collection scope");
            }
            const chain = chainRefResolverPort.resolveChainRef(
                scope.chainRef,
                config.defaultChainId,
            );
            const collection = collectionDetailReadPort.resolveCollectionRef(
                chain.publicChainId,
                scope.collectionRef,
            );
            const media = collectionDetailReadPort.getCollectionMediaState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
            return media.defaultMode;
        },
    };
}

function createPublicCollectionDetailCacheInput(scope: {
    chainRef: string;
    collectionRef: string;
}): GetCollectionDetailInput {
    const input = {
        chainRef: scope.chainRef,
        collectionRef: scope.collectionRef,
        tokenStatus: "listed",
        limit: DEFAULT_PAGE_LIMIT,
        traits: [],
        traitRanges: [],
    } satisfies GetCollectionDetailInput;

    if (!isCollectionDetailDefaultQueryCacheEligible(input)) {
        throw new Error("Invalid public collection detail cache input");
    }

    return input;
}

async function main() {
    const config = loadBackendConfig(process.env);
    const app = await startBackendServer(config);

    logger.info("Backend API ready", {
        component: "BackendApi",
        action: "startup",
        port: config.port,
        defaultChainId: config.defaultChainId,
    });

    const shutdown = () => {
        logger.info("Backend API shutting down", {
            component: "BackendApi",
            action: "shutdown",
        });
        void app.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (isEntrypoint()) {
    main().catch((error) => {
        logger.error("Backend startup failed", {
            component: "BackendApi",
            action: "startup",
            error: String(error),
        });
        process.exit(1);
    });
}

function isEntrypoint(): boolean {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
}
