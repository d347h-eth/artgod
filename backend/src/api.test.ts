import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import {
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_EXTENSION_KEY,
} from "@artgod/shared/extensions/terraforms";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_TARGET_KIND,
    TRADING_JOB_STATUS,
} from "@artgod/shared/types";
import type { BackendSecurityConfig } from "./config.js";
import { QUERY_CACHE_PROVIDERS } from "./ports/query-cache.js";
import {
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
} from "./utils/query-cache-debug.js";

const MILADY_ADDRESS = "0x1111111111111111111111111111111111111111";
const TERRAFORMS_ADDRESS = "0x2222222222222222222222222222222222222222";
const EMBEDDED_TERRAFORMS_MAIN_ADDRESS =
    "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WETH_ADDRESS = "0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const API_SECURITY_CONFIG: BackendSecurityConfig = {
    allowedHosts: ["127.0.0.1", "localhost", "::1", "artgod.network"],
    allowedOrigins: [
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://tauri.localhost",
        "tauri://localhost",
        "https://artgod.network",
    ],
    csrfCookieSecure: false,
};

let dbPath = "";
let app: FastifyInstance | null = null;
let publicApp: FastifyInstance | null = null;
let cachedApp: FastifyInstance | null = null;

beforeAll(async () => {
    dbPath = path.join(
        os.tmpdir(),
        `artgod-backend-api-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.ARTGOD_DB_PATH = dbPath;
    setDbPath(dbPath);

    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();
    seedData();

    const appModule = await import("./http-app.js");
    const backendAppModule = await import("./index.js");
    const chainsUseCaseModule =
        await import("./application/use-cases/chains/get-default-chain.js");
    const listCollectionsUseCaseModule =
        await import("./application/use-cases/collections/list-collections.js");
    const collectionDetailUseCaseModule =
        await import("./application/use-cases/collections/get-collection-detail.js");
    const collectionActivityUseCaseModule =
        await import("./application/use-cases/activities/get-collection-activity.js");
    const activityEventPreviewUseCaseModule =
        await import(
            "./application/use-cases/activities/get-activity-event-preview.js"
        );
    const collectionHoldersUseCaseModule =
        await import("./application/use-cases/collections/get-collection-holders.js");
    const tokenDetailUseCaseModule =
        await import("./application/use-cases/collections/get-token-detail.js");
    const tokenPreviewUseCaseModule =
        await import("./application/use-cases/collections/get-token-preview.js");
    const tokenUriUseCaseModule =
        await import("./application/use-cases/collections/get-token-uri.js");
    const tokenActivityUseCaseModule =
        await import("./application/use-cases/activities/get-token-activity.js");
    const runtimeHealthUseCaseModule =
        await import("./application/use-cases/health/get-runtime-health.js");
    const resolveOwnerRefUseCaseModule =
        await import("./application/use-cases/owners/resolve-owner-ref.js");
    const sqliteRuntimeHealthModule =
        await import("./infra/runtime-health/sqlite-runtime-health.js");
    const readModels = await import("@artgod/shared/read-models");
    const collectionExtensionRecordsModule =
        await import("./infra/collections/sqlite-collection-extension-records.js");
    const collectionCustomizationRecordsModule =
        await import("./infra/collections/sqlite-collection-customization-records.js");
    const extensionAwareCustomizationModule =
        await import("./infra/collections/extension-aware-collection-customization.js");
    const extensionAwareReadModule =
        await import("./infra/collections/extension-aware-collection-detail-read.js");
    const getCollectionCustomizationUseCaseModule =
        await import("./application/use-cases/collections/get-collection-customization.js");
    const updateCollectionCustomizationUseCaseModule =
        await import("./application/use-cases/collections/update-collection-customization.js");

    const chainsReadModel = new readModels.SqliteChainsReadModel();
    const baseCollectionsReadModel = new readModels.SqliteCollectionsReadModel([
        ZERO_ADDRESS,
        WETH_ADDRESS,
    ]);
    const collectionExtensionRecords =
        new collectionExtensionRecordsModule.SqliteCollectionExtensionRecords();
    const collectionCustomizationRecords =
        new collectionCustomizationRecordsModule.SqliteCollectionCustomizationRecords();
    const collectionsReadModel =
        new extensionAwareReadModule.ExtensionAwareCollectionDetailRead(
            baseCollectionsReadModel,
            collectionExtensionRecords,
        );
    const customizationReadModel =
        new extensionAwareCustomizationModule.ExtensionAwareCollectionCustomization(
            collectionExtensionRecords,
            collectionCustomizationRecords,
        );
    const activitiesReadModel = new readModels.SqliteActivitiesReadModel();
    const getDefaultChainUseCase =
        new chainsUseCaseModule.GetDefaultChainUseCase(1, chainsReadModel);
    const listCollectionsUseCase =
        new listCollectionsUseCaseModule.ListCollectionsUseCase(
            1,
            chainsReadModel,
            baseCollectionsReadModel,
        );
    const resolveOwnerRefUseCase =
        new resolveOwnerRefUseCaseModule.ResolveOwnerRefUseCase(
            1,
            chainsReadModel,
            {
                async resolveEnsAddress(name: string) {
                    if (name === "vitalik.eth") {
                        return "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
                    }
                    return null;
                },
            },
        );
    const getCollectionDetailUseCase =
        new collectionDetailUseCaseModule.GetCollectionDetailUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            customizationReadModel,
        );
    const getCollectionActivityUseCase =
        new collectionActivityUseCaseModule.GetCollectionActivityUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            activitiesReadModel,
            collectionsReadModel,
            customizationReadModel,
        );
    const getActivityEventPreviewUseCase =
        new activityEventPreviewUseCaseModule.GetActivityEventPreviewUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            {
                async getActivityEventPreview() {
                    throw new Error("Unexpected activity event preview");
                },
            },
        );
    const getCollectionCustomizationUseCase =
        new getCollectionCustomizationUseCaseModule.GetCollectionCustomizationUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            customizationReadModel,
        );
    const getCollectionHoldersUseCase =
        new collectionHoldersUseCaseModule.GetCollectionHoldersUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
        );
    const getTokenDetailUseCase =
        new tokenDetailUseCaseModule.GetTokenDetailUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            customizationReadModel,
        );
    const getTokenPreviewUseCase =
        new tokenPreviewUseCaseModule.GetTokenPreviewUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
        );
    const getTokenUriUseCase = new tokenUriUseCaseModule.GetTokenUriUseCase(
        1,
        chainsReadModel,
        collectionsReadModel,
        {
            async getTokenUri() {
                return "data:application/json;base64,e30=";
            },
        },
    );
    const getTokenActivityUseCase =
        new tokenActivityUseCaseModule.GetTokenActivityUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            activitiesReadModel,
            collectionsReadModel,
            customizationReadModel,
        );
    const updateCollectionCustomizationUseCase =
        new updateCollectionCustomizationUseCaseModule.UpdateCollectionCustomizationUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            customizationReadModel,
        );
    const runtimeHealthUseCase =
        new runtimeHealthUseCaseModule.GetRuntimeHealthUseCase(
            new sqliteRuntimeHealthModule.SqliteRuntimeHealthAdapter(),
            {
                async assertJobsStreamExists(streamName: string) {
                    if (streamName !== "artgod-jobs") {
                        throw new Error(`Unexpected jobs stream ${streamName}`);
                    }
                },
            },
            "artgod-jobs",
        );
    const biddingJobsRepositoryModule =
        await import("./infra/trading/sqlite-bidding-jobs-repository.js");
    const biddingBidBookRepositoryModule = await import(
        "./infra/trading/sqlite-bidding-bid-book-repository.js"
    );
    const listCollectionBiddingJobsUseCaseModule =
        await import(
            "./application/use-cases/trading/list-collection-bidding-jobs.js"
        );
    const listCollectionBiddingBidBookUseCaseModule = await import(
        "./application/use-cases/trading/list-collection-bidding-bid-book.js"
    );
    const getTokenBiddingJobUseCaseModule =
        await import("./application/use-cases/trading/get-token-bidding-job.js");
    const getTokenBiddingBidBookUseCaseModule = await import(
        "./application/use-cases/trading/get-token-bidding-bid-book.js"
    );
    const upsertTokenBiddingJobUseCaseModule =
        await import(
            "./application/use-cases/trading/upsert-token-bidding-job.js"
        );
    const archiveTokenBiddingJobUseCaseModule =
        await import(
            "./application/use-cases/trading/archive-token-bidding-job.js"
        );
    const biddingJobsRepository =
        new biddingJobsRepositoryModule.SqliteBiddingJobsRepository();
    const biddingBidBookRepository =
        new biddingBidBookRepositoryModule.SqliteBiddingBidBookRepository();
    const listCollectionBiddingJobsUseCase =
        new listCollectionBiddingJobsUseCaseModule.ListCollectionBiddingJobsUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            customizationReadModel,
            biddingJobsRepository,
        );
    const listCollectionBiddingBidBookUseCase =
        new listCollectionBiddingBidBookUseCaseModule.ListCollectionBiddingBidBookUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            customizationReadModel,
            biddingBidBookRepository,
        );
    const getTokenBiddingJobUseCase =
        new getTokenBiddingJobUseCaseModule.GetTokenBiddingJobUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            biddingJobsRepository,
        );
    const getTokenBiddingBidBookUseCase =
        new getTokenBiddingBidBookUseCaseModule.GetTokenBiddingBidBookUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            biddingBidBookRepository,
        );
    const tradingJobCommandSignalPort = {
        publishBiddingJobCommandsChanged: () => undefined,
    };
    const upsertTokenBiddingJobUseCase =
        new upsertTokenBiddingJobUseCaseModule.UpsertTokenBiddingJobUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            biddingJobsRepository,
            tradingJobCommandSignalPort,
        );
    const archiveTokenBiddingJobUseCase =
        new archiveTokenBiddingJobUseCaseModule.ArchiveTokenBiddingJobUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
            biddingJobsRepository,
            tradingJobCommandSignalPort,
        );
    const bootstrapRepositoryModule =
        await import("./infra/bootstrap/sqlite-bootstrap-runs.js");
    const collectionExtensionResolverModule = await import(
        "./infra/collection-extensions/built-in-collection-extension-resolver.js"
    );
    const createBootstrapUseCaseModule =
        await import("./application/use-cases/bootstrap/create-bootstrap-run.js");
    const getBootstrapStatusUseCaseModule =
        await import("./application/use-cases/bootstrap/get-bootstrap-status.js");
    const listBootstrapRunsUseCaseModule =
        await import("./application/use-cases/bootstrap/list-bootstrap-runs.js");
    const getBootstrapRunDetailUseCaseModule =
        await import("./application/use-cases/bootstrap/get-bootstrap-run-detail.js");
    const retryBootstrapRunFailedTasksUseCaseModule =
        await import("./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js");

    const bootstrapRepository =
        new bootstrapRepositoryModule.SqliteBootstrapRunsRepository();
    const bootstrapQueueMock = {
        async publishBootstrapStart() {},
        async publishBootstrapMetadataProcess() {},
    };
    const builtInCollectionExtensionResolver =
        new collectionExtensionResolverModule.BuiltInCollectionExtensionResolver();
    const createBootstrapRunUseCase =
        new createBootstrapUseCaseModule.CreateBootstrapRunUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
            builtInCollectionExtensionResolver,
            bootstrapQueueMock,
        );
    const getBootstrapStatusUseCase =
        new getBootstrapStatusUseCaseModule.GetBootstrapStatusUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
        );
    const listBootstrapRunsUseCase =
        new listBootstrapRunsUseCaseModule.ListBootstrapRunsUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
        );
    const getBootstrapRunDetailUseCase =
        new getBootstrapRunDetailUseCaseModule.GetBootstrapRunDetailUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
        );
    const retryBootstrapRunFailedTasksUseCase =
        new retryBootstrapRunFailedTasksUseCaseModule.RetryBootstrapRunFailedTasksUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
            bootstrapQueueMock,
        );

    app = appModule.createApiApp(
        createBootstrapRunUseCase,
        listBootstrapRunsUseCase,
        getBootstrapRunDetailUseCase,
        getBootstrapStatusUseCase,
        retryBootstrapRunFailedTasksUseCase,
        getDefaultChainUseCase,
        listCollectionsUseCase,
        resolveOwnerRefUseCase,
        getCollectionActivityUseCase,
        getActivityEventPreviewUseCase,
        getTokenActivityUseCase,
        getCollectionCustomizationUseCase,
        getCollectionDetailUseCase,
        getCollectionHoldersUseCase,
        getTokenDetailUseCase,
        getTokenPreviewUseCase,
        getTokenUriUseCase,
        updateCollectionCustomizationUseCase,
        listCollectionBiddingJobsUseCase,
        listCollectionBiddingBidBookUseCase,
        getTokenBiddingJobUseCase,
        getTokenBiddingBidBookUseCase,
        upsertTokenBiddingJobUseCase,
        archiveTokenBiddingJobUseCase,
        runtimeHealthUseCase,
        null,
        API_SECURITY_CONFIG,
        {
            mode: "standard",
            publicCollectionScope: null,
        },
    );
    publicApp = appModule.createApiApp(
        createBootstrapRunUseCase,
        listBootstrapRunsUseCase,
        getBootstrapRunDetailUseCase,
        getBootstrapStatusUseCase,
        retryBootstrapRunFailedTasksUseCase,
        getDefaultChainUseCase,
        listCollectionsUseCase,
        resolveOwnerRefUseCase,
        getCollectionActivityUseCase,
        getActivityEventPreviewUseCase,
        getTokenActivityUseCase,
        getCollectionCustomizationUseCase,
        getCollectionDetailUseCase,
        getCollectionHoldersUseCase,
        getTokenDetailUseCase,
        getTokenPreviewUseCase,
        getTokenUriUseCase,
        updateCollectionCustomizationUseCase,
        listCollectionBiddingJobsUseCase,
        listCollectionBiddingBidBookUseCase,
        getTokenBiddingJobUseCase,
        getTokenBiddingBidBookUseCase,
        upsertTokenBiddingJobUseCase,
        archiveTokenBiddingJobUseCase,
        runtimeHealthUseCase,
        null,
        API_SECURITY_CONFIG,
        {
            mode: "public_single_collection",
            publicCollectionScope: {
                chainRef: "ethereum",
                collectionRef: "terraforms",
            },
        },
    );
    cachedApp = backendAppModule.createBackendApp({
        host: "127.0.0.1",
        port: 3000,
        defaultChainId: 1,
        dbPath,
        rpcUrl: "http://127.0.0.1:8545",
        wethAddress: WETH_ADDRESS,
        natsUrl: "nats://127.0.0.1:4222",
        natsStreamPrefix: "artgod",
        userlandUiDistDir: null,
        security: API_SECURITY_CONFIG,
        deployment: {
            mode: "public_single_collection",
            publicCollectionScope: {
                chainRef: "ethereum",
                collectionRef: "terraforms",
            },
        },
        queryCache: {
            provider: QUERY_CACHE_PROVIDERS.Memory,
            publicCollection: {
                detailRefreshMs: 5000,
                previewWarmRefreshMs: 600000,
            },
            tokenPreview: {
                maxEntries: 16,
                freshMs: 600_000,
                staleMs: 1_200_000,
                warmupConcurrency: 2,
            },
        },
    });
    await app.ready();
    await publicApp.ready();
    await cachedApp.ready();
});

afterAll(async () => {
    await Promise.all([
        app?.close(),
        publicApp?.close(),
        cachedApp?.close(),
        fs.rm(dbPath, { force: true }),
        fs.rm(`${dbPath}-shm`, { force: true }),
        fs.rm(`${dbPath}-wal`, { force: true }),
    ]);
});

describe("backend api routes", () => {
    it("returns the default chain", async () => {
        const result = await resolve("GET", "/api/chains/default");
        expect(result.statusCode).toBe(200);
        expect(result.payload.chain.publicChainId).toBe(1);
        expect(result.payload.chain.slug).toBe("ethereum");
    });

    it("resolves ENS owner refs on the public API", async () => {
        const result = await resolvePublic(
            "GET",
            "/api/ethereum/resolve-owner-ref?value=vitalik.eth",
        );

        expect(result.statusCode).toBe(200);
        expect(result.payload).toEqual({
            input: "vitalik.eth",
            resolvedAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        });
    });

    it("limits public single-collection mode to Terraforms read routes", async () => {
        const terraforms = await resolvePublic(
            "GET",
            "/api/ethereum/terraforms?token_status=all&limit=1",
        );
        expect(terraforms.statusCode).toBe(200);
        expect(terraforms.payload.collection.slug).toBe("terraforms");

        const nonPublicCollection = await resolvePublic(
            "GET",
            "/api/ethereum/milady?token_status=all&limit=1",
        );
        expect(nonPublicCollection.statusCode).toBe(404);
    });

    it("does not register admin routes in public single-collection mode", async () => {
        const collections = await resolvePublic(
            "GET",
            "/api/ethereum/collections?limit=10",
        );
        expect(collections.statusCode).toBe(404);

        const customization = await resolvePublic(
            "GET",
            "/api/ethereum/terraforms/customization",
        );
        expect(customization.statusCode).toBe(404);

        const csrf = await resolvePublic("GET", "/api/security/csrf");
        expect(csrf.statusCode).toBe(404);

        const biddingJobs = await resolvePublic(
            "GET",
            "/api/ethereum/terraforms/bidding/jobs",
        );
        expect(biddingJobs.statusCode).toBe(404);

        const biddingBids = await resolvePublic(
            "GET",
            "/api/ethereum/terraforms/bidding/bids",
        );
        expect(biddingBids.statusCode).toBe(200);
        expect(biddingBids.payload.collection.slug).toBe("terraforms");
        expect(biddingBids.payload.bidBook).toBeDefined();

        const tokenBiddingJob = await resolvePublic(
            "GET",
            "/api/ethereum/terraforms/7710/bidding/job",
        );
        expect(tokenBiddingJob.statusCode).toBe(404);

        const tokenBiddingBids = await resolvePublic(
            "GET",
            "/api/ethereum/terraforms/7710/bidding/bids",
        );
        expect(tokenBiddingBids.statusCode).toBe(200);
        expect(tokenBiddingBids.payload.collection.slug).toBe("terraforms");
        expect(tokenBiddingBids.payload.bidBook).toBeDefined();

        const nonPublicBiddingBids = await resolvePublic(
            "GET",
            "/api/ethereum/milady/bidding/bids",
        );
        expect(nonPublicBiddingBids.statusCode).toBe(404);
    });

    it("lists empty bidding jobs and returns null for tokens without a job", async () => {
        clearTradingJobFixtures();

        const jobs = await resolve("GET", "/api/ethereum/milady/bidding/jobs");
        expect(jobs.statusCode).toBe(200);
        expect(jobs.payload.collection.slug).toBe("milady");
        expect(jobs.payload.media.selectedMode).toBe("snapshot");
        expect(jobs.payload.included.tokensById).toEqual({});
        expect(jobs.payload.jobs).toEqual([]);

        const tokenJob = await resolve(
            "GET",
            "/api/ethereum/milady/1/bidding/job",
        );
        expect(tokenJob.statusCode).toBe(200);
        expect(tokenJob.payload.collection.slug).toBe("milady");
        expect(tokenJob.payload.tokenId).toBe("1");
        expect(tokenJob.payload.job).toBeNull();
    });

    it("reads bid book from indexed orders when a collection has no enabled bidding jobs", async () => {
        clearTradingJobFixtures();
        db.prepare("DELETE FROM orders WHERE id IN (?, ?, ?, ?, ?, ?)").run(
            "bid-book-collection",
            "bid-book-token-1",
            "bid-book-token-1-low",
            "bid-book-raw-biome-42",
            "bid-book-biome-42-terrain",
            "bid-book-stream-fallback",
        );
        insertOrderFixture({
            id: "bid-book-collection",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: null,
            sourceScopeKind: "collection",
            price: "100000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "bid-book-collection",
                contract: MILADY_ADDRESS,
                priceWei: "100000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
        });
        insertOrderFixture({
            id: "bid-book-token-1",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: "1",
            sourceScopeKind: "token",
            price: "200000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "bid-book-token-1",
                contract: MILADY_ADDRESS,
                tokenId: "1",
                priceWei: "200000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
        });
        insertOrderFixture({
            id: "bid-book-token-1-low",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: "1",
            sourceScopeKind: "token",
            price: "9000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "bid-book-token-1-low",
                contract: MILADY_ADDRESS,
                tokenId: "1",
                priceWei: "9000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
        });
        insertOrderFixture({
            id: "bid-book-raw-biome-42",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: null,
            sourceScopeKind: "collection",
            price: "620000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            rawRestData: {
                order_hash: "bid-book-raw-biome-42",
                protocol_address:
                    "0x0000000000000068f116a894984e2db1123eb395",
                remaining_quantity: 2,
                protocol_data: {
                    parameters: {
                        offerer:
                            "0x9999999999999999999999999999999999999999",
                        offer: [
                            {
                                itemType: 1,
                                token: WETH_ADDRESS,
                                identifierOrCriteria: "0",
                                startAmount: "620000000000000000",
                                endAmount: "620000000000000000",
                            },
                        ],
                        consideration: [
                            {
                                itemType: 4,
                                token: MILADY_ADDRESS,
                                identifierOrCriteria:
                                    "113703377976973476812273708665395356499261988770439230068849221413098206214838",
                                startAmount: "2",
                                endAmount: "2",
                                recipient:
                                    "0x9999999999999999999999999999999999999999",
                            },
                        ],
                        orderType: 3,
                        endTime: "4000000000",
                    },
                },
                criteria: {
                    collection: { slug: "milady" },
                    contract: { address: MILADY_ADDRESS },
                    trait: null,
                    traits: null,
                    numeric_traits: [{ type: "Biome", min: 42, max: 42 }],
                    encoded_token_ids: "1,2,3",
                },
            },
        });
        insertOrderFixture({
            id: "bid-book-biome-42-terrain",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: null,
            sourceScopeKind: "attribute",
            price: "400000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            sourceSchemaJson: {
                kind: "attribute",
                data: {
                    collection: MILADY_ADDRESS,
                    attributes: [
                        { key: "Biome", value: "42" },
                        { key: "Mode", value: "Terrain" },
                    ],
                },
            },
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "bid-book-biome-42-terrain",
                contract: MILADY_ADDRESS,
                priceWei: "400000000000000000",
                traits: [
                    { type: "Biome", value: "42" },
                    { type: "Mode", value: "Terrain" },
                ],
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
        });
        insertOrderFixture({
            id: "bid-book-stream-fallback",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: null,
            sourceScopeKind: "collection",
            price: "150000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            rawRestData: { order_hash: "bid-book-stream-fallback" },
            rawStreamData: makeOpenSeaBuyOrderPayload({
                orderId: "bid-book-stream-fallback",
                contract: MILADY_ADDRESS,
                priceWei: "150000000000000000",
                maker: "0x8888888888888888888888888888888888888888",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
        });

        const tokenScopedBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids",
        );
        expect(tokenScopedBidBook.statusCode).toBe(200);
        expect(tokenScopedBidBook.payload.scopeFilter).toBe("token");
        const tokenScopedOrderIds =
            tokenScopedBidBook.payload.bidBook.bids.map(
                (bid: { orderId: string }) => bid.orderId,
            );
        expect(tokenScopedOrderIds).toContain("bid-book-token-1");
        expect(tokenScopedOrderIds).not.toContain("bid-book-token-1-low");
        expect(tokenScopedOrderIds).not.toContain("bid-book-collection");
        expect(tokenScopedOrderIds).not.toContain("bid-book-raw-biome-42");
        expect(tokenScopedOrderIds).not.toContain(
            "bid-book-biome-42-terrain",
        );
        const tokenOneOfferCard =
            tokenScopedBidBook.payload.tokenOfferCards.items.find(
                (card: { tokenId: string }) => card.tokenId === "1",
            );
        expect(tokenOneOfferCard).toMatchObject({
            tokenId: "1",
            offers: [{ orderId: "bid-book-token-1" }],
        });
        expect(tokenOneOfferCard.offers).toHaveLength(1);
        expect(tokenScopedBidBook.payload.tokenOfferCards.totalOffers).toBe(
            tokenScopedBidBook.payload.bidBook.bids.length,
        );

        const collectionBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=collection",
        );
        expect(collectionBidBook.statusCode).toBe(200);
        expect(collectionBidBook.payload.bidBook.state.source).toBe("orders");
        expect(collectionBidBook.payload.bidBook.state.updatedAt).toEqual(
            expect.any(String),
        );
        expect(collectionBidBook.payload.scopeFilter).toBe("collection");
        const collectionOrderIds = collectionBidBook.payload.bidBook.bids.map(
            (bid: { orderId: string }) => bid.orderId,
        );
        expect(collectionOrderIds).toContain("bid-book-collection");
        expect(collectionOrderIds).toContain("bid-book-stream-fallback");
        expect(collectionOrderIds).not.toContain("bid-book-token-1");
        expect(collectionOrderIds).not.toContain("bid-book-raw-biome-42");
        expect(collectionOrderIds).not.toContain("bid-book-biome-42-terrain");

        const makerFilteredCollectionBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=collection&maker=0x8888888888888888888888888888888888888888",
        );
        expect(makerFilteredCollectionBidBook.statusCode).toBe(200);
        expect(
            makerFilteredCollectionBidBook.payload.bidBook.bids.map(
                (bid: { orderId: string }) => bid.orderId,
            ),
        ).toEqual(["bid-book-stream-fallback"]);

        const filteredCollectionBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=traits&traits=Biome:42",
        );
        expect(filteredCollectionBidBook.statusCode).toBe(200);
        expect(filteredCollectionBidBook.payload.scopeFilter).toBe("traits");
        const filteredOrderIds =
            filteredCollectionBidBook.payload.bidBook.bids.map(
                (bid: { orderId: string }) => bid.orderId,
            );
        expect(filteredOrderIds).not.toContain("bid-book-collection");
        expect(filteredOrderIds).toContain("bid-book-biome-42-terrain");
        const rawTraitBid = filteredCollectionBidBook.payload.bidBook.bids.find(
            (bid: { orderId: string }) =>
                bid.orderId === "bid-book-raw-biome-42",
        );
        expect(rawTraitBid).toMatchObject({
            orderId: "bid-book-raw-biome-42",
            scope: {
                kind: "trait",
                label: "Biome=42",
                traits: [{ type: "Biome", value: "42" }],
            },
            priceWei: "310000000000000000",
        });

        const strictTraitBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=traits&trait_join=and&traits=Biome:42",
        );
        expect(strictTraitBidBook.statusCode).toBe(200);
        const strictTraitOrderIds = strictTraitBidBook.payload.bidBook.bids.map(
            (bid: { orderId: string }) => bid.orderId,
        );
        expect(strictTraitOrderIds).toContain("bid-book-raw-biome-42");
        expect(strictTraitOrderIds).not.toContain(
            "bid-book-biome-42-terrain",
        );

        const exactMultiTraitBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=traits&trait_join=and&traits=Biome:42&traits=Mode:Terrain",
        );
        expect(exactMultiTraitBidBook.statusCode).toBe(200);
        const exactMultiTraitOrderIds =
            exactMultiTraitBidBook.payload.bidBook.bids.map(
                (bid: { orderId: string }) => bid.orderId,
            );
        expect(exactMultiTraitOrderIds).toContain("bid-book-biome-42-terrain");
        expect(exactMultiTraitOrderIds).not.toContain(
            "bid-book-raw-biome-42",
        );

        const tokenBidBook = await resolve(
            "GET",
            "/api/ethereum/milady/1/bidding/bids",
        );
        expect(tokenBidBook.statusCode).toBe(200);
        expect(tokenBidBook.payload.bidBook.state.source).toBe("orders");
        const tokenOrderIds = tokenBidBook.payload.bidBook.bids.map(
            (bid: { orderId: string }) => bid.orderId,
        );
        expect(tokenOrderIds).toEqual(
            expect.arrayContaining(["bid-book-token-1", "bid-book-collection"]),
        );
        expect(tokenOrderIds.indexOf("bid-book-token-1")).toBeLessThan(
            tokenOrderIds.indexOf("bid-book-collection"),
        );
    });

    it("uses bot snapshot bids only when the bidding bot heartbeat and projection are fresh", async () => {
        clearTradingJobFixtures();
        db.prepare("DELETE FROM orders WHERE id IN (?, ?)").run(
            "bid-book-runtime-orders",
            "bid-book-runtime-snapshot",
        );
        insertOrderFixture({
            id: "bid-book-runtime-orders",
            side: "buy",
            contract: MILADY_ADDRESS,
            tokenId: null,
            sourceScopeKind: "collection",
            price: "100000000000000000",
            currency: WETH_ADDRESS,
            sourceStatus: "active",
            fillabilityStatus: "fillable",
            validFrom: 1,
            validUntil: 4_000_000_000,
            rawRestData: makeOpenSeaBuyOrderPayload({
                orderId: "bid-book-runtime-orders",
                contract: MILADY_ADDRESS,
                priceWei: "100000000000000000",
                validFrom: 1,
                validUntil: 4_000_000_000,
            }),
        });

        const collection = getCollectionFixtureByAddress(MILADY_ADDRESS);
        db.prepare(
            "INSERT INTO trading_jobs " +
                "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id, revision) " +
                "VALUES (?, ?, 1, ?, ?, ?, '1', 1)",
        ).run(
            "runtime-source-job",
            TRADING_BOT_KIND.Bidding,
            collection.collection_id,
            TRADING_JOB_STATUS.Enabled,
            TRADING_JOB_TARGET_KIND.Token,
        );
        db.prepare(
            "INSERT INTO trading_bidding_job_specs " +
                "(job_id, floor_wei, ceiling_wei, delta_wei) " +
                "VALUES (?, '100000000000000000', '200000000000000000', '10000000000000000')",
        ).run("runtime-source-job");
        db.prepare(
            "INSERT INTO trading_bidding_bid_book_rows " +
                "(chain_id, collection_id, order_id, source, scope_kind, scope_label, maker, is_own, price_wei, currency_address, snapshot_refreshed_at_ms) " +
                "VALUES (1, ?, ?, ?, ?, 'collection', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, '300000000000000000', ?, ?)",
        ).run(
            collection.collection_id,
            "bid-book-runtime-snapshot",
            TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
            TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            WETH_ADDRESS.toLowerCase(),
            Date.now(),
        );
        db.prepare(
            "INSERT INTO trading_bidding_collection_bid_book_state " +
                "(chain_id, collection_id, source, snapshot_refreshed_at_ms, projected_at, row_count, duration_ms, last_error) " +
                "VALUES (1, ?, ?, ?, ?, 1, 1, NULL)",
        ).run(
            collection.collection_id,
            TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
            Date.now(),
            new Date().toISOString(),
        );

        const noRuntimeHeartbeat = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=collection",
        );
        expect(noRuntimeHeartbeat.statusCode).toBe(200);
        expect(noRuntimeHeartbeat.payload.bidBook.state.source).toBe("orders");
        expect(
            noRuntimeHeartbeat.payload.bidBook.bids.map(
                (bid: { orderId: string }) => bid.orderId,
            ),
        ).toContain("bid-book-runtime-orders");

        db.prepare(
            "INSERT INTO trading_bot_runtime_state " +
                "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
                "VALUES (?, 1, 'wallet-1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, ?, ?, ?, NULL)",
        ).run(
            TRADING_BOT_KIND.Bidding,
            TRADING_BOT_RUNTIME_STATE.Running,
            new Date().toISOString(),
            new Date().toISOString(),
            new Date().toISOString(),
        );

        const liveRuntime = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=collection",
        );
        expect(liveRuntime.statusCode).toBe(200);
        expect(liveRuntime.payload.bidBook.state.source).toBe("bot_snapshot");
        expect(
            liveRuntime.payload.bidBook.bids.map(
                (bid: { orderId: string }) => bid.orderId,
            ),
        ).toContain("bid-book-runtime-snapshot");

        db.prepare(
            "UPDATE trading_bot_runtime_state " +
                "SET heartbeat_at = ?, updated_at = ? " +
                "WHERE bot_kind = ? AND chain_id = 1 AND wallet_id = 'wallet-1'",
        ).run(
            new Date(Date.now() - 31_000).toISOString(),
            new Date().toISOString(),
            TRADING_BOT_KIND.Bidding,
        );

        const staleHeartbeat = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=collection",
        );
        expect(staleHeartbeat.statusCode).toBe(200);
        expect(staleHeartbeat.payload.bidBook.state.source).toBe("orders");

        db.prepare(
            "UPDATE trading_bot_runtime_state " +
                "SET heartbeat_at = ?, updated_at = ? " +
                "WHERE bot_kind = ? AND chain_id = 1 AND wallet_id = 'wallet-1'",
        ).run(
            new Date().toISOString(),
            new Date().toISOString(),
            TRADING_BOT_KIND.Bidding,
        );

        db.prepare(
            "UPDATE trading_bidding_collection_bid_book_state " +
                "SET snapshot_refreshed_at_ms = ? " +
                "WHERE chain_id = 1 AND collection_id = ? AND source = ?",
        ).run(
            Date.now() - 121_000,
            collection.collection_id,
            TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        );

        const staleProjection = await resolve(
            "GET",
            "/api/ethereum/milady/bidding/bids?bid_scope=collection",
        );
        expect(staleProjection.statusCode).toBe(200);
        expect(staleProjection.payload.bidBook.state.source).toBe("orders");
    });

    it("creates and updates token bidding jobs via admin routes", async () => {
        clearTradingJobFixtures();
        const csrf = await issueAdminCsrf();

        const created = await resolve(
            "PUT",
            "/api/ethereum/milady/1/bidding/job",
            {
                status: TRADING_JOB_STATUS.Enabled,
                floorEth: "0.1",
                ceilingEth: "0.2",
                deltaEth: "0.01",
            },
            csrf,
        );
        expect(created.statusCode).toBe(200);
        expect(created.payload.tokenId).toBe("1");
        expect(created.payload.job.status).toBe(TRADING_JOB_STATUS.Enabled);
        expect(created.payload.job.revision).toBe(1);
        expect(created.payload.job.target).toEqual({
            type: "token",
            tokenId: "1",
        });
        expect(created.payload.job.config).toEqual({
            floorEth: "0.1",
            ceilingEth: "0.2",
            deltaEth: "0.01",
        });

        const updated = await resolve(
            "PUT",
            "/api/ethereum/milady/1/bidding/job",
            {
                status: TRADING_JOB_STATUS.Paused,
                floorEth: "0.11",
                ceilingEth: "0.22",
                deltaEth: "0.02",
            },
            csrf,
        );
        expect(updated.statusCode).toBe(200);
        expect(updated.payload.job.status).toBe(TRADING_JOB_STATUS.Paused);
        expect(updated.payload.job.revision).toBe(2);
        expect(updated.payload.job.config).toEqual({
            floorEth: "0.11",
            ceilingEth: "0.22",
            deltaEth: "0.02",
        });

        const jobs = await resolve("GET", "/api/ethereum/milady/bidding/jobs");
        expect(jobs.statusCode).toBe(200);
        expect(jobs.payload.jobs).toHaveLength(1);
        expect(jobs.payload.included.tokensById["1"]).toMatchObject({
            tokenId: "1",
        });
        expect(jobs.payload.jobs[0].target).toEqual({
            type: "token",
            tokenId: "1",
        });
        expect(jobs.payload.jobs[0].status).toBe(TRADING_JOB_STATUS.Paused);

        const tokenJob = await resolve(
            "GET",
            "/api/ethereum/milady/1/bidding/job",
        );
        expect(tokenJob.statusCode).toBe(200);
        expect(tokenJob.payload.job.config).toEqual({
            floorEth: "0.11",
            ceilingEth: "0.22",
            deltaEth: "0.02",
        });
        expect(listTradingCommandKinds()).toEqual([
            TRADING_JOB_COMMAND_KIND.JobCreated,
            TRADING_JOB_COMMAND_KIND.JobPaused,
            TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
        ]);
    });

    it("archives token bidding jobs and enqueues active-offer cancellation", async () => {
        clearTradingJobFixtures();
        const csrf = await issueAdminCsrf();

        const created = await resolve(
            "PUT",
            "/api/ethereum/milady/1/bidding/job",
            {
                status: TRADING_JOB_STATUS.Enabled,
                floorEth: "0.1",
                ceilingEth: "0.2",
                deltaEth: "0.01",
            },
            csrf,
        );
        expect(created.statusCode).toBe(200);

        const archived = await resolve(
            "DELETE",
            "/api/ethereum/milady/1/bidding/job",
            undefined,
            csrf,
        );
        expect(archived.statusCode).toBe(200);
        expect(archived.payload.job.status).toBe(TRADING_JOB_STATUS.Archived);
        expect(archived.payload.job.archivedAt).toEqual(expect.any(String));

        const jobs = await resolve("GET", "/api/ethereum/milady/bidding/jobs");
        expect(jobs.statusCode).toBe(200);
        expect(jobs.payload.jobs).toEqual([]);

        const tokenJob = await resolve(
            "GET",
            "/api/ethereum/milady/1/bidding/job",
        );
        expect(tokenJob.statusCode).toBe(200);
        expect(tokenJob.payload.job).toBeNull();
        expect(listTradingCommandKinds()).toEqual([
            TRADING_JOB_COMMAND_KIND.JobCreated,
            TRADING_JOB_COMMAND_KIND.JobArchived,
            TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
        ]);
    });

    it("rejects invalid token bidding job payloads", async () => {
        clearTradingJobFixtures();
        const csrf = await issueAdminCsrf();

        const invalidStatus = await resolve(
            "PUT",
            "/api/ethereum/milady/1/bidding/job",
            {
                status: TRADING_JOB_STATUS.Archived,
                floorEth: "0.1",
                ceilingEth: "0.2",
                deltaEth: "0.01",
            },
            csrf,
        );
        expect(invalidStatus.statusCode).toBe(400);
        expect(invalidStatus.payload).toEqual({
            error: "bad_request",
            message: "status is invalid",
        });

        const invalidRange = await resolve(
            "PUT",
            "/api/ethereum/milady/1/bidding/job",
            {
                status: TRADING_JOB_STATUS.Enabled,
                floorEth: "0.3",
                ceilingEth: "0.2",
                deltaEth: "0.01",
            },
            csrf,
        );
        expect(invalidRange.statusCode).toBe(422);
        expect(invalidRange.payload).toEqual({
            error: "validation_error",
            message: "floorEth must be <= ceilingEth",
        });
    });

    it("returns 404 when archiving a token without an active bidding job", async () => {
        clearTradingJobFixtures();
        const csrf = await issueAdminCsrf();

        const archived = await resolve(
            "DELETE",
            "/api/ethereum/milady/1/bidding/job",
            undefined,
            csrf,
        );
        expect(archived.statusCode).toBe(404);
        expect(archived.payload).toEqual({
            error: "not_found",
            message: "Unknown bidding job",
        });
    });

    it("reports runtime health with semantic checks", async () => {
        const result = await resolve("GET", "/health/runtime");
        expect(result.statusCode).toBe(200);
        expect(result.payload.ok).toBe(true);
        expect(result.payload.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    key: "backendProcess",
                    status: "pass",
                }),
                expect.objectContaining({ key: "database", status: "pass" }),
                expect.objectContaining({ key: "queue", status: "pass" }),
            ]),
        );
    });

    it("lists collections with cursor pagination", async () => {
        const first = await resolve("GET", "/api/ethereum/collections?limit=1");
        expect(first.statusCode).toBe(200);
        expect(first.payload.page.items).toHaveLength(1);
        expect(first.payload.page.items[0].slug).toBe("milady");
        expect(first.payload.page.nextCursor).toEqual(expect.any(String));

        const second = await resolve(
            "GET",
            `/api/ethereum/collections?limit=1&cursor=${encodeURIComponent(first.payload.page.nextCursor)}`,
        );
        expect(second.statusCode).toBe(200);
        expect(second.payload.page.items).toHaveLength(1);
        expect(second.payload.page.items[0].address).toBe(TERRAFORMS_ADDRESS);
    });

    it("filters collections by status", async () => {
        const result = await resolve(
            "GET",
            "/api/1/collections?status=bootstrapping&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.page.items).toHaveLength(1);
        expect(result.payload.page.items[0].address).toBe(TERRAFORMS_ADDRESS);
    });

    it("defaults collection detail to listed tokens sorted by price", async () => {
        const result = await resolve("GET", "/api/ethereum/milady?limit=1");
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(result.payload.tokens.items).toHaveLength(1);
        expect(result.payload.tokens.items[0].tokenId).toBe("1");
        expect(result.payload.tokens.items[0].listingPrice).toBe(
            "500000000000000000",
        );
        expect(result.payload.tokens.items[0].listingCurrency).toBe(
            ZERO_ADDRESS,
        );
        expect(result.payload.tokens.items[0].traitSummary).toBeNull();
        expect(result.payload.tokens.prevCursor).toBeNull();
        expect(result.payload.tokens.nextCursor).toEqual(expect.any(String));
        expect(result.payload.tokens.totalItems).toBe(2);
        expect(result.payload.tokens.rangeStart).toBe(1);
        expect(result.payload.tokens.rangeEnd).toBe(1);
        expect(result.payload.tokens.currentPage).toBe(1);
        expect(result.payload.tokens.totalPages).toBe(2);
    });

    it("marks cached collection detail responses with query cache headers", async () => {
        const warmed = await waitForCachedHit(
            "/api/ethereum/terraforms?limit=250",
        );
        expect(warmed.statusCode).toBe(200);
        expect(
            warmed.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe("hit");
        expect(
            warmed.headers[QUERY_CACHE_DEBUG_TTL_HEADER_NAME.toLowerCase()],
        ).toBe("5000");
        expect(
            Number(
                warmed.headers[
                    QUERY_CACHE_DEBUG_AGE_HEADER_NAME.toLowerCase()
                ],
            ),
        ).toBeGreaterThanOrEqual(0);

        const explicitDefaultMode = await resolveCached(
            "GET",
            "/api/ethereum/terraforms?limit=250&media_mode=artifact",
        );
        expect(explicitDefaultMode.statusCode).toBe(200);
        expect(
            explicitDefaultMode.headers[
                QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()
            ],
        ).toBe("hit");

        const nonDefaultMode = await resolveCached(
            "GET",
            "/api/ethereum/terraforms?limit=250&media_mode=snapshot",
        );
        expect(nonDefaultMode.statusCode).toBe(200);
        expect(
            nonDefaultMode.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe("bypass");

        const bypass = await resolveCached(
            "GET",
            "/api/ethereum/terraforms?limit=1",
        );
        expect(bypass.statusCode).toBe(200);
        expect(
            bypass.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe("bypass");
        expect(
            bypass.headers[QUERY_CACHE_DEBUG_AGE_HEADER_NAME.toLowerCase()],
        ).toBeUndefined();
        expect(
            bypass.headers[QUERY_CACHE_DEBUG_TTL_HEADER_NAME.toLowerCase()],
        ).toBeUndefined();
    });

    it("returns show-all collection detail with existing token-id ordering", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/milady?token_status=all&limit=2",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(result.payload.tokens.items).toHaveLength(2);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1", "2"]);
        expect(result.payload.tokens.prevCursor).toBeNull();
        expect(result.payload.tokens.nextCursor).toEqual(expect.any(String));
        expect(result.payload.tokens.totalItems).toBe(3);
        expect(result.payload.tokens.rangeStart).toBe(1);
        expect(result.payload.tokens.rangeEnd).toBe(2);
        expect(result.payload.tokens.currentPage).toBe(1);
        expect(result.payload.tokens.totalPages).toBe(2);
        expect(result.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ key: "Hat" }),
                expect.objectContaining({ key: "Mood" }),
            ]),
        );
        expect(result.payload.tokens.items[0].listingPrice).toBe(
            "500000000000000000",
        );
        expect(result.payload.tokens.items[1].listingPrice).toBeNull();
    });

    it("returns token detail with animation_url fallback data and rarity stats", async () => {
        const result = await resolve("GET", "/api/ethereum/milady/1");
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.slug).toBe("milady");
        expect(result.payload.token.tokenId).toBe("1");
        expect(result.payload.token.name).toBe("Milady #1");
        expect(result.payload.token.image).toBe("https://example.com/1.png");
        expect(result.payload.token.animationUrl).toBe(
            "https://example.com/1.html",
        );
        expect(result.payload.token.listingPrice).toBe("500000000000000000");
        expect(result.payload.token.listingCurrency).toBe(
            "0x0000000000000000000000000000000000000000",
        );
        expect(result.payload.token.attributes).toHaveLength(3);
        expect(result.payload.token.attributes[0]).toMatchObject({
            key: "Hat",
            value: "Beanie",
            tokenCount: 2,
        });
        expect(result.payload.token.attributes[1]).toMatchObject({
            key: "Mood",
            value: "Calm",
            tokenCount: 2,
        });
        expect(result.payload.token.attributes[2]).toMatchObject({
            key: "Power",
            value: "7",
            tokenCount: 1,
        });
        expect(result.payload.token.attributes[0].rarityPercent).toBeCloseTo(
            66.6666,
            3,
        );
        expect(result.payload.token.attributes[1].rarityPercent).toBeCloseTo(
            66.6666,
            3,
        );
        expect(result.payload.token.attributes[2].rarityPercent).toBeCloseTo(
            33.3333,
            3,
        );
        expect(result.payload.traitFilterPresentation.effectiveConfig.rangeKeys).toEqual(
            [],
        );
    });

    it("returns token preview with only media payload needed by the modal", async () => {
        const result = await resolve("GET", "/api/ethereum/terraforms/7710/preview");

        expect(result.statusCode).toBe(200);
        expect(Object.keys(result.payload)).toEqual(["media", "token"]);
        expect(result.payload.media.selectedMode).toBe("artifact");
        expect(result.payload.media.defaultMode).toBe("artifact");
        expect(result.payload.media.availableModes).toEqual([
            { key: "artifact", label: "artifact" },
            { key: "lost-terrain", label: "lost" },
            { key: "snapshot", label: "snapshot" },
        ]);
        expect(result.payload.token).toEqual({
            tokenId: "7710",
            image: "data:image/svg+xml;base64,terraforms-v2-image",
            animationUrl: `data:text/html;base64,${Buffer.from("<html><body>terraforms-v2</body></html>", "utf8").toString("base64")}`,
        });
    });

    it("returns Terraforms lost-terrain preview only when the token has that artifact", async () => {
        const lost = await resolve(
            "GET",
            "/api/ethereum/terraforms/7710/preview?media_mode=lost-terrain",
        );
        expect(lost.statusCode).toBe(200);
        expect(lost.payload.media.selectedMode).toBe("lost-terrain");
        expect(lost.payload.token.image).toBe(
            "data:image/svg+xml;base64,terraforms-lost-image",
        );
        expect(lost.payload.token.animationUrl).toBe(
            `data:text/html;base64,${Buffer.from("<html><body>terraforms-lost</body></html>", "utf8").toString("base64")}`,
        );

        const terrain = await resolve(
            "GET",
            "/api/ethereum/terraforms/7711/preview?media_mode=lost-terrain",
        );
        expect(terrain.statusCode).toBe(200);
        expect(terrain.payload.media.availableModes).toEqual([
            { key: "artifact", label: "artifact" },
            { key: "snapshot", label: "snapshot" },
        ]);
        expect(terrain.payload.media.selectedMode).toBe("artifact");
    });

    it("marks warmed preview responses with query cache headers", async () => {
        await waitForCachedHit("/api/ethereum/terraforms?limit=250");
        const preview = await waitForCachedHit(
            "/api/ethereum/terraforms/7710/preview?media_mode=artifact",
        );
        expect(preview.statusCode).toBe(200);
        expect(
            preview.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe("hit");
        expect(
            preview.headers[QUERY_CACHE_DEBUG_TTL_HEADER_NAME.toLowerCase()],
        ).toBe("1200000");
        expect(
            Number(
                preview.headers[
                    QUERY_CACHE_DEBUG_AGE_HEADER_NAME.toLowerCase()
                ],
            ),
        ).toBeGreaterThanOrEqual(0);
    });

    it("warms preview cache from the default collection page", async () => {
        const page = await waitForCachedHit("/api/ethereum/terraforms?limit=250");
        expect(page.statusCode).toBe(200);
        await waitForAsyncTasks();

        const preview = await resolveCached(
            "GET",
            "/api/ethereum/terraforms/7710/preview?media_mode=artifact",
        );
        expect(preview.statusCode).toBe(200);
        expect(
            preview.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe("hit");
    });

    it("returns collection activity with bidirectional pagination metadata", async () => {
        const first = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=2",
        );

        expect(first.statusCode).toBe(200);
        expect(first.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(first.payload.traits.selected).toEqual([]);
        expect(first.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ key: "Hat" }),
                expect.objectContaining({ key: "Mood" }),
            ]),
        );
        expect(first.payload.activities.items).toHaveLength(2);
        expect(first.payload.activities.prevCursor).toBeNull();
        expect(first.payload.activities.totalItems).toBe(5);
        expect(first.payload.activities.rangeStart).toBe(1);
        expect(first.payload.activities.rangeEnd).toBe(2);
        expect(first.payload.activities.currentPage).toBe(1);
        expect(first.payload.activities.totalPages).toBe(3);
        expect(first.payload.included.tokensById).toEqual({
            "1": {
                tokenId: "1",
                name: "Milady #1",
                image: "https://example.com/1.png",
                traitSummary: null,
                hasMetadata: true,
                metadataUpdatedAt: "2026-01-01T00:00:00Z",
            },
        });
        expect(first.payload.included.hasTraitSummaryTemplate).toBe(false);
        expect(
            first.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([ACTIVITY_KIND.Sale, ACTIVITY_KIND.Transfer]);
        expect(first.payload.activities.items[0]).toMatchObject({
            tokenId: "1",
            sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
            sourceName: "seaport",
            price: "500000000000000000",
            currency: ZERO_ADDRESS,
            txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        expect(first.payload.activities.items[1]).toMatchObject({
            tokenId: "1",
            sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
            sourceName: "onchain",
            amount: "1",
            from: "0x9999999999999999999999999999999999999999",
            to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        expect(first.payload.activities.nextCursor).toEqual(expect.any(String));

        const second = await resolve(
            "GET",
            `/api/ethereum/milady/activity?limit=2&cursor=${encodeURIComponent(first.payload.activities.nextCursor)}`,
        );

        expect(second.statusCode).toBe(200);
        expect(
            second.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([
            ACTIVITY_KIND.ListingCancelled,
            ACTIVITY_KIND.ListingCreated,
        ]);
        expect(second.payload.activities.prevCursor).toBeNull();
        expect(second.payload.activities.nextCursor).toEqual(
            expect.any(String),
        );
        expect(second.payload.activities.rangeStart).toBe(3);
        expect(second.payload.activities.rangeEnd).toBe(4);
        expect(second.payload.activities.currentPage).toBe(2);

        const third = await resolve(
            "GET",
            `/api/ethereum/milady/activity?limit=2&cursor=${encodeURIComponent(second.payload.activities.nextCursor)}`,
        );

        expect(third.statusCode).toBe(200);
        expect(
            third.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([ACTIVITY_KIND.BidCreated]);
        expect(third.payload.activities.prevCursor).toEqual(expect.any(String));
        expect(third.payload.activities.nextCursor).toBeNull();
        expect(third.payload.activities.rangeStart).toBe(5);
        expect(third.payload.activities.rangeEnd).toBe(5);
        expect(third.payload.activities.currentPage).toBe(3);

        const previousOfThird = await resolve(
            "GET",
            `/api/ethereum/milady/activity?limit=2&cursor=${encodeURIComponent(third.payload.activities.prevCursor)}`,
        );
        expect(
            previousOfThird.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([
            ACTIVITY_KIND.ListingCancelled,
            ACTIVITY_KIND.ListingCreated,
        ]);
    });

    it("filters collection activity by grouped kind", async () => {
        const sales = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=sales",
        );
        expect(sales.statusCode).toBe(200);
        expect(
            sales.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([ACTIVITY_KIND.Sale]);
        expect(sales.payload.activities.totalItems).toBe(1);

        const listings = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=listings",
        );
        expect(listings.statusCode).toBe(200);
        expect(
            listings.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([ACTIVITY_KIND.ListingCreated]);
        expect(listings.payload.activities.totalItems).toBe(1);

        const transfers = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=transfers",
        );
        expect(transfers.statusCode).toBe(200);
        expect(
            transfers.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([ACTIVITY_KIND.Transfer]);
        expect(transfers.payload.activities.totalItems).toBe(1);
    });

    it("filters collection activity by token traits while returning collection-wide facets", async () => {
        const matching = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=sales&traits=Hat:Beanie,Mood:Calm",
        );
        expect(matching.statusCode).toBe(200);
        expect(matching.payload.traits.selected).toEqual([
            { key: "Hat", value: "Beanie" },
            { key: "Mood", value: "Calm" },
        ]);
        expect(matching.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ key: "Hat" }),
                expect.objectContaining({ key: "Mood" }),
            ]),
        );
        expect(
            matching.payload.activities.items.map(
                (activity: { tokenId: string | null }) => activity.tokenId,
            ),
        ).toEqual(["1"]);

        const empty = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=sales&traits=Hat:Cap",
        );
        expect(empty.statusCode).toBe(200);
        expect(empty.payload.activities.items).toHaveLength(0);
        expect(empty.payload.activities.totalItems).toBe(0);
    });

    it("returns token activity filtered to a single token", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/milady/1/activity?limit=10",
        );

        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.slug).toBe("milady");
        expect(result.payload.token.tokenId).toBe("1");
        expect(result.payload.included.tokensById).toEqual({
            "1": {
                tokenId: "1",
                name: "Milady #1",
                image: "https://example.com/1.png",
                traitSummary: null,
                hasMetadata: true,
                metadataUpdatedAt: "2026-01-01T00:00:00Z",
            },
        });
        expect(result.payload.included.hasTraitSummaryTemplate).toBe(false);
        expect(
            result.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([
            ACTIVITY_KIND.Sale,
            ACTIVITY_KIND.Transfer,
            ACTIVITY_KIND.ListingCancelled,
            ACTIVITY_KIND.ListingCreated,
        ]);
        expect(
            result.payload.activities.items.every(
                (activity: { tokenId: string | null }) =>
                    activity.tokenId === "1",
            ),
        ).toBe(true);
        expect(result.payload.activities.items[2]).toMatchObject({
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            side: "sell",
            price: "500000000000000000",
            currency: ZERO_ADDRESS,
            payload: {
                eventType: "item_cancelled",
            },
        });
        expect(result.payload.activities.items[3]).toMatchObject({
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            side: "sell",
            price: "500000000000000000",
            currency: ZERO_ADDRESS,
            payload: {
                eventType: "item_listed",
            },
        });

        const listingsOnly = await resolve(
            "GET",
            "/api/ethereum/milady/1/activity?limit=10&kind=listings",
        );
        expect(
            listingsOnly.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([ACTIVITY_KIND.ListingCreated]);
    });

    it("collapses collection listings by token, maker, currency, and UTC day while leaving token listings raw", async () => {
        const makerA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const makerB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        insertActivityFixture({
            collectionAddress: MILADY_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            tokenId: "2",
            occurredAt: 1_726_000_900,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            orderId: "listed-milady-2-maker-a-early",
            maker: makerA,
            side: "sell",
            price: "400000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
            dedupeKey:
                "offchain:opensea:item_listed:listed-milady-2-maker-a-early:2",
            isOpen: true,
        });
        insertActivityFixture({
            collectionAddress: MILADY_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            tokenId: "2",
            occurredAt: 1_726_001_200,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            orderId: "listed-milady-2-maker-a-late",
            maker: makerA,
            side: "sell",
            price: "420000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
            dedupeKey:
                "offchain:opensea:item_listed:listed-milady-2-maker-a-late:2",
            isOpen: true,
        });
        insertActivityFixture({
            collectionAddress: MILADY_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            tokenId: "2",
            occurredAt: 1_726_001_100,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            orderId: "listed-milady-2-maker-b",
            maker: makerB,
            side: "sell",
            price: "410000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
            dedupeKey: "offchain:opensea:item_listed:listed-milady-2-maker-b:2",
            isOpen: true,
        });
        insertActivityFixture({
            collectionAddress: MILADY_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            tokenId: "2",
            occurredAt: 1_726_001_000,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            orderId: "listed-milady-2-maker-a-weth",
            maker: makerA,
            side: "sell",
            price: "405000000000000000",
            currency: WETH_ADDRESS,
            payload: { eventType: "item_listed" },
            dedupeKey:
                "offchain:opensea:item_listed:listed-milady-2-maker-a-weth:2",
            isOpen: true,
        });
        insertActivityFixture({
            collectionAddress: MILADY_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            tokenId: "2",
            occurredAt: 1_726_088_000,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            orderId: "listed-milady-2-maker-a-next-day",
            maker: makerA,
            side: "sell",
            price: "430000000000000000",
            currency: ZERO_ADDRESS,
            payload: { eventType: "item_listed" },
            dedupeKey:
                "offchain:opensea:item_listed:listed-milady-2-maker-a-next-day:2",
            isOpen: true,
        });

        const collectionListings = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=listings",
        );

        expect(collectionListings.statusCode).toBe(200);
        expect(collectionListings.payload.activities.totalItems).toBe(5);
        expect(collectionListings.payload.activities.items).toHaveLength(5);
        expect(
            collectionListings.payload.activities.items.map(
                (activity: { kind: string }) => activity.kind,
            ),
        ).toEqual([
            ACTIVITY_KIND.ListingCreated,
            ACTIVITY_KIND.ListingCreated,
            ACTIVITY_KIND.ListingCreated,
            ACTIVITY_KIND.ListingCreated,
            ACTIVITY_KIND.ListingCreated,
        ]);

        const collapsedSameDay =
            collectionListings.payload.activities.items.find(
                (activity: {
                    tokenId: string | null;
                    maker: string | null;
                    currency: string | null;
                    occurredAt: number;
                }) =>
                    activity.tokenId === "2" &&
                    activity.maker === makerA &&
                    activity.currency === ZERO_ADDRESS.toLowerCase() &&
                    activity.occurredAt === 1_726_001_200,
            );
        expect(collapsedSameDay).toMatchObject({
            tokenId: "2",
            maker: makerA,
            currency: ZERO_ADDRESS.toLowerCase(),
            price: "420000000000000000",
            isCollapsed: true,
            collapsedEventCount: 2,
        });
        expect(
            (
                collapsedSameDay as {
                    collapsedWindowStartUtc: number | null;
                    collapsedWindowEndUtc: number | null;
                }
            ).collapsedWindowEndUtc! -
                (
                    collapsedSameDay as {
                        collapsedWindowStartUtc: number | null;
                        collapsedWindowEndUtc: number | null;
                    }
                ).collapsedWindowStartUtc!,
        ).toBe(86_399);

        const filteredCollapsedListings = await resolve(
            "GET",
            "/api/ethereum/milady/activity?limit=10&kind=listings&traits=Mood:Angry",
        );
        expect(filteredCollapsedListings.statusCode).toBe(200);
        expect(filteredCollapsedListings.payload.activities.totalItems).toBe(4);
        expect(
            filteredCollapsedListings.payload.activities.items.every(
                (activity: { tokenId: string | null }) =>
                    activity.tokenId === "2",
            ),
        ).toBe(true);

        const tokenListings = await resolve(
            "GET",
            "/api/ethereum/milady/2/activity?limit=10&kind=listings",
        );

        expect(tokenListings.statusCode).toBe(200);
        expect(tokenListings.payload.activities.totalItems).toBe(5);
        expect(tokenListings.payload.activities.items).toHaveLength(5);
        expect(
            tokenListings.payload.activities.items.every(
                (activity: {
                    kind: string;
                    isCollapsed: boolean;
                    collapsedEventCount: number | null;
                }) =>
                    activity.kind === ACTIVITY_KIND.ListingCreated &&
                    activity.isCollapsed === false &&
                    activity.collapsedEventCount === null,
            ),
        ).toBe(true);
    });

    it("returns owner-scoped collection detail with listed tokens first and owner-scoped facets", async () => {
        clearNftBalances(MILADY_ADDRESS);
        insertNftBalance(
            MILADY_ADDRESS,
            "1",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "2",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "10",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "1",
        );

        const result = await resolve(
            "GET",
            "/api/ethereum/milady?owner=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token_status=listed_then_unlisted&limit=10",
        );

        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1", "2"]);
        expect(result.payload.tokens.items[0].listingPrice).toBe(
            "500000000000000000",
        );
        expect(result.payload.tokens.items[1].listingPrice).toBeNull();
        expect(result.payload.tokens.totalItems).toBe(2);
        expect(result.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    key: "Hat",
                    displayKind: "set",
                    minValue: null,
                    maxValue: null,
                    values: [{ value: "Beanie", tokenCount: 2 }],
                }),
                expect.objectContaining({
                    key: "Mood",
                    displayKind: "set",
                    minValue: null,
                    maxValue: null,
                    values: [
                        { value: "Angry", tokenCount: 1 },
                        { value: "Calm", tokenCount: 1 },
                    ],
                }),
                expect.objectContaining({
                    key: "Power",
                    displayKind: "set",
                    minValue: null,
                    maxValue: null,
                    values: [
                        { value: "2", tokenCount: 1 },
                        { value: "7", tokenCount: 1 },
                    ],
                }),
            ]),
        );
    });

    it("supports backward paging for owner-scoped listed-then-unlisted mode", async () => {
        clearNftBalances(MILADY_ADDRESS);
        insertNftBalance(
            MILADY_ADDRESS,
            "1",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "2",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "10",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );

        const first = await resolve(
            "GET",
            "/api/ethereum/milady?owner=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token_status=listed_then_unlisted&limit=1",
        );
        const second = await resolve(
            "GET",
            `/api/ethereum/milady?owner=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token_status=listed_then_unlisted&limit=1&cursor=${encodeURIComponent(first.payload.tokens.nextCursor)}`,
        );
        const third = await resolve(
            "GET",
            `/api/ethereum/milady?owner=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token_status=listed_then_unlisted&limit=1&cursor=${encodeURIComponent(second.payload.tokens.nextCursor)}`,
        );

        expect(first.payload.tokens.items[0].tokenId).toBe("1");
        expect(second.payload.tokens.items[0].tokenId).toBe("10");
        expect(third.payload.tokens.items[0].tokenId).toBe("2");
        expect(third.payload.tokens.prevCursor).toEqual(expect.any(String));

        const previousOfThird = await resolve(
            "GET",
            `/api/ethereum/milady?owner=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token_status=listed_then_unlisted&limit=1&cursor=${encodeURIComponent(third.payload.tokens.prevCursor)}`,
        );
        expect(previousOfThird.payload.tokens.items[0].tokenId).toBe("10");
    });

    it("returns current holder on token detail", async () => {
        clearNftBalances(MILADY_ADDRESS);
        insertNftBalance(
            MILADY_ADDRESS,
            "1",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );

        const result = await resolve("GET", "/api/ethereum/milady/1");

        expect(result.statusCode).toBe(200);
        expect(result.payload.token.currentHolder).toBe(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        expect(result.payload.token.listingPrice).toBe("500000000000000000");
    });

    it("matches owner-scoped token queries against mixed-case owner refs", async () => {
        clearNftBalances(MILADY_ADDRESS);
        const collection = getCollectionFixtureByAddress(MILADY_ADDRESS);
        db.prepare(
            "INSERT OR REPLACE INTO nft_balances " +
                "(chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
        ).run(
            1,
            collection.collection_id,
            MILADY_ADDRESS,
            "1",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
            1,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            1_726_000_000,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            0,
        );

        const result = await resolve(
            "GET",
            "/api/ethereum/milady?owner=0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa&token_status=listed_then_unlisted&limit=10",
        );

        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1"]);
    });

    it("returns Terraforms media overrides from extension artifacts", async () => {
        const result = await resolve("GET", "/api/ethereum/terraforms/7710");
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.address).toBe(TERRAFORMS_ADDRESS);
        expect(result.payload.media.selectedMode).toBe("artifact");
        expect(result.payload.media.defaultMode).toBe("artifact");
        expect(result.payload.media.availableModes).toEqual([
            { key: "artifact", label: "artifact" },
            { key: "lost-terrain", label: "lost" },
            { key: "snapshot", label: "snapshot" },
        ]);
        expect(result.payload.token.tokenId).toBe("7710");
        expect(result.payload.token.image).toBe(
            "data:image/svg+xml;base64,terraforms-v2-image",
        );
        expect(result.payload.token.animationUrl).toBe(
            `data:text/html;base64,${Buffer.from("<html><body>terraforms-v2</body></html>", "utf8").toString("base64")}`,
        );
    });

    it("returns Terraforms lost-terrain media only for non-terrain tokens", async () => {
        const lost = await resolve(
            "GET",
            "/api/ethereum/terraforms/7710?media_mode=lost-terrain",
        );
        expect(lost.statusCode).toBe(200);
        expect(lost.payload.media.selectedMode).toBe("lost-terrain");
        expect(lost.payload.token.image).toBe(
            "data:image/svg+xml;base64,terraforms-lost-image",
        );
        expect(lost.payload.token.animationUrl).toBe(
            `data:text/html;base64,${Buffer.from("<html><body>terraforms-lost</body></html>", "utf8").toString("base64")}`,
        );

        const terrain = await resolve("GET", "/api/ethereum/terraforms/7711");
        expect(terrain.statusCode).toBe(200);
        expect(terrain.payload.media.availableModes).toEqual([
            { key: "artifact", label: "artifact" },
            { key: "snapshot", label: "snapshot" },
        ]);
    });

    it("returns Terraforms canonical media when snapshot mode is requested", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/terraforms/7710?media_mode=snapshot",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.media.selectedMode).toBe("snapshot");
        expect(result.payload.token.image).toBe(
            "https://example.com/terraforms-default.png",
        );
        expect(result.payload.token.animationUrl).toBe(
            "https://example.com/terraforms-default.html",
        );
    });

    it("returns Terraforms collection tokens with overridden images", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/terraforms?token_status=all&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.media.selectedMode).toBe("artifact");
        expect(result.payload.tokens.items).toHaveLength(2);
        expect(result.payload.tokens.items[0].tokenId).toBe("7710");
        expect(result.payload.tokens.items[0].image).toBe(
            "data:image/svg+xml;base64,terraforms-v2-image",
        );
        expect(result.payload.tokens.items[0].traitSummary).toBe("L/B/");
    });

    it("returns Terraforms collection tokens with canonical images in snapshot mode", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/terraforms?token_status=all&limit=10&media_mode=snapshot",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.media.selectedMode).toBe("snapshot");
        expect(result.payload.tokens.items[0].image).toBe(
            "https://example.com/terraforms-default.png",
        );
    });

    it("returns Terraforms activity token includes using the selected media mode", async () => {
        insertActivityFixture({
            collectionAddress: TERRAFORMS_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.Sale,
            tokenId: "7710",
            occurredAt: 1_726_100_000,
            sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
            sourceName: "seaport",
            orderId: "terraforms-sale-7710",
            blockNumber: 22_010_000,
            txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            logIndex: 1,
            from: "0x9999999999999999999999999999999999999999",
            to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            maker: "0x9999999999999999999999999999999999999999",
            taker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            side: "sell",
            amount: "1",
            price: "1000000000000000000",
            currency: ZERO_ADDRESS,
            dedupeKey:
                "onchain:sale:7710:0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:1:7710",
        });

        const artifact = await resolve(
            "GET",
            "/api/ethereum/terraforms/activity?limit=10&kind=sales",
        );
        expect(artifact.statusCode).toBe(200);
        expect(artifact.payload.media.selectedMode).toBe("artifact");
        expect(artifact.payload.included.hasTraitSummaryTemplate).toBe(true);
        expect(artifact.payload.included.tokensById["7710"].image).toBe(
            "data:image/svg+xml;base64,terraforms-v2-image",
        );
        expect(artifact.payload.included.tokensById["7710"].traitSummary).toBe(
            "L/B/",
        );

        const snapshot = await resolve(
            "GET",
            "/api/ethereum/terraforms/activity?limit=10&kind=sales&media_mode=snapshot",
        );
        expect(snapshot.statusCode).toBe(200);
        expect(snapshot.payload.media.selectedMode).toBe("snapshot");
        expect(snapshot.payload.included.hasTraitSummaryTemplate).toBe(true);
        expect(snapshot.payload.included.tokensById["7710"].image).toBe(
            "https://example.com/terraforms-default.png",
        );
    });

    it("returns extension event media includes for Terraforms activity rows", async () => {
        const txHash =
            "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        insertActivityFixture({
            collectionAddress: TERRAFORMS_ADDRESS,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.Custom,
            tokenId: "7710",
            occurredAt: 1_726_100_100,
            sourceKind: ACTIVITY_SOURCE_KIND.Extension,
            sourceName: TERRAFORMS_EXTENSION_KEY,
            blockNumber: 22_010_001,
            txHash,
            logIndex: 8,
            maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            payload: {
                eventKey: "terraformed",
                contentHash:
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            dedupeKey: `extension:terraforms:terraformed:7710:${txHash}:8`,
        });
        const collection = getCollectionFixtureByAddress(TERRAFORMS_ADDRESS);
        db.prepare(
            "INSERT INTO collection_extension_event_media " +
                "(chain_id, collection_id, extension_key, event_key, contract_address, token_id, media_ref, block_number, block_hash, block_timestamp, tx_hash, log_index, image, render_modes_json) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            1,
            collection.collection_id,
            TERRAFORMS_EXTENSION_KEY,
            "terraformed",
            TERRAFORMS_ADDRESS,
            "7710",
            "terraformed-preview",
            22_010_001,
            `0x${"44".repeat(32)}`,
            1_726_100_100,
            txHash,
            8,
            "data:image/svg+xml;base64,event-canvas",
            JSON.stringify([
                { key: "artifact", label: "artifact" },
                { key: "network", label: "network" },
            ]),
        );

        const result = await resolve(
            "GET",
            "/api/ethereum/terraforms/activity?limit=10&extension_event=terraforms:terraformed",
        );

        expect(result.statusCode).toBe(200);
        const activity = result.payload.activities.items.find(
            (item: { txHash: string }) => item.txHash === txHash,
        );
        expect(activity).toBeDefined();
        expect(
            result.payload.included.eventMediaByActivityId[
                String(activity.id)
            ],
        ).toMatchObject({
            image: "data:image/svg+xml;base64,event-canvas",
            mediaRef: "terraformed-preview",
            renderModes: [
                { key: "artifact", label: "artifact" },
                { key: "network", label: "network" },
            ],
        });
    });

    it("returns collection holders as a forward cursor page", async () => {
        clearNftBalances(MILADY_ADDRESS);
        insertNftBalance(
            MILADY_ADDRESS,
            "1",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "2",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "10",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "1",
        );
        insertNftBalance(
            MILADY_ADDRESS,
            "999",
            "0xcccccccccccccccccccccccccccccccccccccccc",
            "1",
        );

        const first = await resolve(
            "GET",
            "/api/ethereum/milady/holders?limit=2",
        );
        expect(first.statusCode).toBe(200);
        expect(first.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(first.payload.holders.items).toEqual([
            {
                owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                tokenCount: "2",
                heldPercent: 50,
            },
            {
                owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                tokenCount: "1",
                heldPercent: 25,
            },
        ]);
        expect(first.payload.holders.totalItems).toBe(3);
        expect(first.payload.holders.limit).toBe(2);
        expect(first.payload.holders.rangeStart).toBe(1);
        expect(first.payload.holders.rangeEnd).toBe(2);
        expect(first.payload.holders.currentPage).toBe(1);
        expect(first.payload.holders.totalPages).toBe(2);
        expect(first.payload.holders.nextCursor).toEqual(expect.any(String));

        const second = await resolve(
            "GET",
            `/api/ethereum/milady/holders?limit=2&cursor=${encodeURIComponent(first.payload.holders.nextCursor)}`,
        );
        expect(second.statusCode).toBe(200);
        expect(second.payload.holders.items).toEqual([
            {
                owner: "0xcccccccccccccccccccccccccccccccccccccccc",
                tokenCount: "1",
                heldPercent: 25,
            },
        ]);
        expect(second.payload.holders.nextCursor).toBeNull();
        expect(second.payload.holders.rangeStart).toBe(3);
        expect(second.payload.holders.rangeEnd).toBe(3);
        expect(second.payload.holders.currentPage).toBe(2);
        expect(second.payload.holders.totalPages).toBe(2);
    });

    it("normalizes holder owner casing in holder list", async () => {
        clearNftBalances(TERRAFORMS_ADDRESS);
        insertNftBalance(
            TERRAFORMS_ADDRESS,
            "7710",
            "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            "1",
        );
        insertNftBalance(
            TERRAFORMS_ADDRESS,
            "7711",
            "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "1",
        );
        insertNftBalance(
            TERRAFORMS_ADDRESS,
            "7712",
            "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc",
            "1",
        );

        const first = await resolve("GET", "/api/ethereum/terraforms/holders");

        expect(first.statusCode).toBe(200);
        expect(first.payload.holders.items).toHaveLength(3);
        expect(first.payload.holders.items[2].owner).toBe(
            "0xcccccccccccccccccccccccccccccccccccccccc",
        );
        expect(first.payload.holders.nextCursor).toBeNull();
    });

    it("rejects invalid holders cursor values", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/milady/holders?limit=2&cursor=not-a-valid-cursor",
        );
        expect(result.statusCode).toBe(400);
    });

    it("returns 404 for unknown token detail", async () => {
        const result = await resolve("GET", "/api/ethereum/milady/999999");
        expect(result.statusCode).toBe(404);
    });

    it("supports backward paging with prevCursor", async () => {
        const first = await resolve(
            "GET",
            "/api/ethereum/milady?token_status=all&limit=1",
        );
        const second = await resolve(
            "GET",
            `/api/ethereum/milady?token_status=all&limit=1&cursor=${encodeURIComponent(first.payload.tokens.nextCursor)}`,
        );
        const third = await resolve(
            "GET",
            `/api/ethereum/milady?token_status=all&limit=1&cursor=${encodeURIComponent(second.payload.tokens.nextCursor)}`,
        );

        expect(second.payload.tokens.prevCursor).toBeNull();
        expect(third.payload.tokens.prevCursor).toEqual(expect.any(String));

        const previousOfThird = await resolve(
            "GET",
            `/api/ethereum/milady?token_status=all&limit=1&cursor=${encodeURIComponent(third.payload.tokens.prevCursor)}`,
        );
        expect(previousOfThird.payload.tokens.items[0].tokenId).toBe("2");
    });

    it("applies AND semantics across different trait keys", async () => {
        const result = await resolve(
            "GET",
            "/api/1/milady?token_status=all&traits=Hat:Beanie,Mood:Calm&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1"]);
    });

    it("applies OR semantics for values within the same trait key", async () => {
        const result = await resolve(
            "GET",
            "/api/1/milady?token_status=all&traits=Hat:Beanie,Hat:Cap&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1", "2", "10"]);
    });

    it("reads collection customization defaults and extension overrides", async () => {
        const milady = await resolve(
            "GET",
            "/api/ethereum/milady/customization",
        );
        expect(milady.statusCode).toBe(200);
        expect(
            milady.payload.customization.traitFilterPresentation,
        ).toMatchObject({
            selectedSource: "user",
            userConfig: { rangeKeys: [] },
            extensionConfig: null,
        });
        expect(
            milady.payload.customization.traitFilterPresentation
                .availableTraitKeys,
        ).toEqual(expect.arrayContaining(["Hat", "Mood", "Power"]));
        expect(
            milady.payload.customization.tokenCardTraitSummaryTemplate,
        ).toMatchObject({
            selectedSource: "user",
            userConfig: { template: "" },
            extensionConfig: null,
            effectiveConfig: { template: "" },
        });
        expect(
            milady.payload.customization.activityRowTraitSummaryTemplate,
        ).toMatchObject({
            selectedSource: "user",
            userConfig: { template: "" },
            extensionConfig: null,
            effectiveConfig: { template: "" },
        });

        const terraforms = await resolve(
            "GET",
            "/api/ethereum/terraforms/customization",
        );
        expect(terraforms.statusCode).toBe(200);
        expect(
            terraforms.payload.customization.traitFilterPresentation,
        ).toMatchObject({
            selectedSource: "extension",
            extensionConfig: { rangeKeys: ["???"] },
            effectiveConfig: { rangeKeys: ["???"] },
        });
        expect(
            terraforms.payload.customization.traitFilterPresentation
                .availableTraitKeys,
        ).toEqual(expect.arrayContaining(["???"]));
        expect(
            terraforms.payload.customization.tokenCardTraitSummaryTemplate,
        ).toMatchObject({
            selectedSource: "extension",
            extensionConfig: { template: "L{Level}/B{Biome}/{Zone}" },
            effectiveConfig: { template: "L{Level}/B{Biome}/{Zone}" },
        });
        expect(
            terraforms.payload.customization.activityRowTraitSummaryTemplate,
        ).toMatchObject({
            selectedSource: "extension",
            extensionConfig: { template: "L{Level}/B{Biome}/{Zone}" },
            effectiveConfig: { template: "L{Level}/B{Biome}/{Zone}" },
        });
    });

    it("updates collection trait filter presentation and applies range filtering to tokens and activities", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const update = await resolve(
            "PUT",
            "/api/ethereum/milady/customization",
            {
                traitFilterPresentation: {
                    selectedSource: "user",
                    userConfig: {
                        rangeKeys: ["Power"],
                    },
                },
                tokenCardTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "",
                    },
                },
                activityRowTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "",
                    },
                },
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
            },
        );
        expect(update.statusCode).toBe(200);
        expect(
            update.payload.customization.traitFilterPresentation,
        ).toMatchObject({
            selectedSource: "user",
            userConfig: { rangeKeys: ["Power"] },
            effectiveConfig: { rangeKeys: ["Power"] },
        });

        const detail = await resolve(
            "GET",
            "/api/ethereum/milady?token_status=all&trait_ranges=Power:3..9&limit=10",
        );
        expect(detail.statusCode).toBe(200);
        expect(detail.payload.traits.selectedRanges).toEqual([
            { key: "Power", fromValue: "3", toValue: "9" },
        ]);
        expect(detail.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    key: "Power",
                    displayKind: "range",
                    minValue: "2",
                    maxValue: "7",
                }),
            ]),
        );
        expect(
            detail.payload.tokens.items.map(
                (item: { tokenId: string }) => item.tokenId,
            ),
        ).toEqual(["1"]);

        const activity = await resolve(
            "GET",
            "/api/ethereum/milady/activity?kind=sales&trait_ranges=Power:3..9&limit=10",
        );
        expect(activity.statusCode).toBe(200);
        expect(activity.payload.traits.selectedRanges).toEqual([
            { key: "Power", fromValue: "3", toValue: "9" },
        ]);
        expect(activity.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    key: "Power",
                    displayKind: "range",
                    minValue: "2",
                    maxValue: "7",
                }),
            ]),
        );
        expect(
            activity.payload.activities.items.map(
                (item: { tokenId: string | null }) => item.tokenId,
            ),
        ).toEqual(["1"]);

        const revert = await resolve(
            "PUT",
            "/api/ethereum/milady/customization",
            {
                traitFilterPresentation: {
                    selectedSource: "user",
                    userConfig: {
                        rangeKeys: [],
                    },
                },
                tokenCardTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "",
                    },
                },
                activityRowTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "",
                    },
                },
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
            },
        );
        expect(revert.statusCode).toBe(200);
    });

    it("updates trait summary templates and applies them to token cards and activity includes", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const update = await resolve(
            "PUT",
            "/api/ethereum/milady/customization",
            {
                traitFilterPresentation: {
                    selectedSource: "user",
                    userConfig: {
                        rangeKeys: [],
                    },
                },
                tokenCardTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "P{Power}",
                    },
                },
                activityRowTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "P{Power}",
                    },
                },
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
            },
        );
        expect(update.statusCode).toBe(200);
        expect(
            update.payload.customization.tokenCardTraitSummaryTemplate,
        ).toMatchObject({
            selectedSource: "user",
            effectiveConfig: { template: "P{Power}" },
        });
        expect(
            update.payload.customization.activityRowTraitSummaryTemplate,
        ).toMatchObject({
            selectedSource: "user",
            effectiveConfig: { template: "P{Power}" },
        });

        const detail = await resolve(
            "GET",
            "/api/ethereum/milady?token_status=all&limit=10",
        );
        expect(detail.statusCode).toBe(200);
        expect(detail.payload.tokens.items[0].traitSummary).toBe("P7");
        expect(detail.payload.tokens.items[1].traitSummary).toBe("P2");

        const activity = await resolve(
            "GET",
            "/api/ethereum/milady/activity?kind=sales&limit=10",
        );
        expect(activity.statusCode).toBe(200);
        expect(activity.payload.included.hasTraitSummaryTemplate).toBe(true);
        expect(activity.payload.included.tokensById["1"].traitSummary).toBe(
            "P7",
        );

        const revert = await resolve(
            "PUT",
            "/api/ethereum/milady/customization",
            {
                traitFilterPresentation: {
                    selectedSource: "user",
                    userConfig: {
                        rangeKeys: [],
                    },
                },
                tokenCardTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "",
                    },
                },
                activityRowTraitSummaryTemplate: {
                    selectedSource: "user",
                    userConfig: {
                        template: "",
                    },
                },
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
            },
        );
        expect(revert.statusCode).toBe(200);
    });

    it("rejects collection address refs", async () => {
        const result = await resolve(
            "GET",
            `/api/ethereum/${MILADY_ADDRESS}?token_status=all&limit=10`,
        );
        expect(result.statusCode).toBe(404);
    });

    it("rejects invalid token browser status values", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/milady?token_status=bad&limit=10",
        );
        expect(result.statusCode).toBe(400);
    });

    it("rejects invalid owner values on collection detail", async () => {
        const result = await resolve(
            "GET",
            "/api/ethereum/milady?owner=not-an-address&token_status=listed_then_unlisted&limit=10",
        );
        expect(result.statusCode).toBe(400);
    });

    it("creates and reads bootstrap run via secured endpoints", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        expect(csrf.statusCode).toBe(200);
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;
        expect(token).toHaveLength(32);
        expect(cookie).toContain("artgod_csrf=");

        const create = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "terraforms",
                address: TERRAFORMS_ADDRESS,
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(create.statusCode).toBe(200);
        expect(create.payload.runId).toEqual(expect.any(Number));

        const status = await resolve(
            "GET",
            "/api/ethereum/terraforms/bootstrap",
            undefined,
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:3000",
            },
        );
        expect(status.statusCode).toBe(200);
        expect(status.payload.collection.address).toBe(TERRAFORMS_ADDRESS);
        expect(status.payload.latestRun.runId).toBe(create.payload.runId);
    });

    it("accepts configured public origin and host for secured endpoints", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "artgod.network",
            origin: "https://artgod.network",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const create = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "public-origin-bootstrap",
                address: "0x4444444444444444444444444444444444444444",
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "artgod.network",
                origin: "https://artgod.network",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );

        expect(create.statusCode).toBe(200);
    });

    it("returns CORS headers for local desktop WebView origins", async () => {
        const response = await resolve("GET", "/api/chains/default", undefined, {
            host: "127.0.0.1:3000",
            origin: "tauri://localhost",
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(
            "tauri://localhost",
        );
        expect(response.headers["access-control-allow-credentials"]).toBe(
            "true",
        );
    });

    it("persists embedded extension key when bootstrap scope matches", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const create = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "terraforms-embedded-extension",
                address: EMBEDDED_TERRAFORMS_MAIN_ADDRESS,
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(create.statusCode).toBe(200);

        const row = db
            .prepare<
                [number]
            >("SELECT request_extension_key FROM bootstrap_runs WHERE run_id = ? LIMIT 1")
            .get(create.payload.runId) as
            | { request_extension_key: string | null }
            | undefined;
        expect(row?.request_extension_key).toBe(
            TERRAFORMS_EXTENSION_KEY,
        );
    });

    it("lists bootstrap runs and returns run detail", async () => {
        const runId = insertBootstrapRun({
            chainId: 1,
            collectionAddress: MILADY_ADDRESS,
            status: "completed",
            metadataMode: "best_effort",
            anchorBlock: 24_500_000,
            anchorBlockHash:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            anchorBlockTimestamp: 1_726_000_000,
        });
        insertBootstrapRunEvent(runId, "run.requested");
        insertBootstrapRunEvent(runId, "run.queued");
        insertBootstrapRunEvent(runId, "run.anchor.selected");
        insertBootstrapRunEvent(runId, "metadata.enumeration.started");
        insertBootstrapRunEvent(runId, "metadata.enumeration.completed");
        insertBootstrapRunEvent(runId, "metadata.tasks.seeded");
        insertBootstrapRunEvent(runId, "metadata.queued");
        insertBootstrapMetadataTask(runId, "1", "failed_terminal");
        insertBootstrapMetadataTask(runId, "2", "succeeded");
        updateCollectionLifecycle(MILADY_ADDRESS, {
            status: "live",
            bootstrapFinishedAt: "2026-02-01T00:01:00Z",
            bootstrapLastSyncedBlock: 24_500_100,
            openseaSlug: "milady-maker",
            openseaStatus: "ready",
            openseaReadyAt: "2026-02-01T00:02:00Z",
            openseaSnapshotStartedAt: "2026-02-01T00:01:10Z",
            openseaSnapshotCompletedAt: "2026-02-01T00:01:50Z",
            openseaLastError: null,
        });

        const list = await resolve(
            "GET",
            "/api/ethereum/bootstrap-runs?limit=10",
        );
        expect(list.statusCode).toBe(200);
        expect(list.payload.page.items.length).toBeGreaterThan(0);
        expect(
            list.payload.page.items.some(
                (item: { run: { runId: number } }) => item.run.runId === runId,
            ),
        ).toBe(true);

        const detail = await resolve(
            "GET",
            `/api/ethereum/bootstrap-runs/${runId}`,
        );
        expect(detail.statusCode).toBe(200);
        expect(detail.payload.run.runId).toBe(runId);
        expect(detail.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(detail.payload.metadataTasks.total).toBe(2);
        expect(detail.payload.flow.shouldPoll).toBe(false);
        expect(
            detail.payload.flow.steps.map((step: { key: string }) => step.key),
        ).toEqual([
            "requested",
            "queued",
            "anchor",
            "enumeration",
            "metadata",
            "ownership",
            "backfill",
            "collection_live",
            "opensea_identity",
            "opensea_snapshot",
            "opensea_ready",
        ]);
        expect(
            detail.payload.flow.steps.find(
                (step: { key: string }) => step.key === "metadata",
            ),
        ).toEqual(
            expect.objectContaining({
                state: "completed",
                progress: {
                    completed: 1,
                    total: 2,
                },
            }),
        );
        expect(
            detail.payload.flow.steps.find(
                (step: { key: string }) => step.key === "opensea_ready",
            ),
        ).toEqual(expect.objectContaining({ state: "completed" }));
        expect(detail.payload.failedMetadataTasksPreview).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ status: "failed_terminal" }),
            ]),
        );
    });

    it("suppresses opensea flow steps for non-latest runs", async () => {
        const olderRunId = insertBootstrapRun({
            chainId: 1,
            collectionAddress: MILADY_ADDRESS,
            status: "completed",
            metadataMode: "best_effort",
            anchorBlock: 24_500_200,
            anchorBlockHash:
                "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            anchorBlockTimestamp: 1_726_000_200,
        });
        insertBootstrapRunEvent(olderRunId, "run.requested");
        insertBootstrapRunEvent(olderRunId, "run.queued");
        insertBootstrapRunEvent(olderRunId, "run.anchor.selected");
        insertBootstrapRunEvent(olderRunId, "metadata.enumeration.completed");
        insertBootstrapRunEvent(olderRunId, "metadata.queued");

        insertBootstrapRun({
            chainId: 1,
            collectionAddress: MILADY_ADDRESS,
            status: "completed",
            metadataMode: "best_effort",
            anchorBlock: 24_500_210,
            anchorBlockHash:
                "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            anchorBlockTimestamp: 1_726_000_210,
        });
        updateCollectionLifecycle(MILADY_ADDRESS, {
            status: "live",
            openseaSlug: "milady-maker",
            openseaStatus: "ready",
            openseaReadyAt: "2026-02-02T00:02:00Z",
            openseaSnapshotStartedAt: "2026-02-02T00:01:00Z",
            openseaSnapshotCompletedAt: "2026-02-02T00:01:40Z",
            openseaLastError: null,
        });

        const detail = await resolve(
            "GET",
            `/api/ethereum/bootstrap-runs/${olderRunId}`,
        );
        expect(detail.statusCode).toBe(200);
        expect(detail.payload.isLatestForCollection).toBe(false);
        expect(
            detail.payload.flow.steps.some((step: { key: string }) =>
                step.key.startsWith("opensea_"),
            ),
        ).toBe(false);
    });

    it("retries failed tasks for a specific run", async () => {
        const runId = insertBootstrapRun({
            chainId: 1,
            collectionAddress: MILADY_ADDRESS,
            status: "metadata",
            metadataMode: "strict",
            anchorBlock: 24_500_123,
            anchorBlockHash:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            anchorBlockTimestamp: 1_726_000_123,
        });
        insertBootstrapMetadataTask(runId, "100", "failed_terminal");
        insertBootstrapMetadataTask(runId, "101", "failed_terminal");

        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const retried = await resolve(
            "POST",
            `/api/ethereum/bootstrap-runs/${runId}/retry-failed`,
            {},
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(retried.statusCode).toBe(200);
        expect(retried.payload.runId).toBe(runId);
        expect(retried.payload.updatedCount).toBe(2);
        expect(retried.payload.status).toBe("metadata");

        const statuses = db
            .prepare<
                [number]
            >("SELECT status FROM bootstrap_metadata_snapshot_tasks WHERE run_id = ? ORDER BY token_id ASC")
            .all(runId) as Array<{ status: string }>;
        expect(statuses.map((item) => item.status)).toEqual(["retry", "retry"]);
    });

    it("removes legacy collection-scoped bootstrap mutation endpoints", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const retryOld = await resolve(
            "POST",
            "/api/ethereum/terraforms/bootstrap/retry-failed",
            {},
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(retryOld.statusCode).toBe(404);

        const restartOld = await resolve(
            "POST",
            "/api/ethereum/terraforms/bootstrap/restart",
            {
                slug: "terraforms",
                address: TERRAFORMS_ADDRESS,
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(restartOld.statusCode).toBe(404);
    });

    it("rejects bootstrap write requests without csrf token", async () => {
        const response = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "terraforms-2",
                address: "0x3333333333333333333333333333333333333333",
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                "content-type": "application/json",
            },
        );
        expect(response.statusCode).toBe(403);
        expect(response.payload.error).toBe("forbidden");
    });

    it("rejects bootstrap write requests for hosts outside the allowlist", async () => {
        const response = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "forbidden-host",
                address: "0x5555555555555555555555555555555555555555",
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "evil.example",
                origin: "https://artgod.network",
                "content-type": "application/json",
            },
        );

        expect(response.statusCode).toBe(403);
        expect(response.payload).toEqual({
            error: "forbidden",
            message: "Invalid host",
        });
    });

    it("adds Secure to the CSRF cookie when configured", async () => {
        const { createIssueCsrfTokenHandler } =
            await import("./http/common/security.js");
        const { default: Fastify } = await import("fastify");

        const secureApp = Fastify({ logger: false });
        secureApp.get(
            "/api/security/csrf",
            createIssueCsrfTokenHandler({
                allowedHosts: [...API_SECURITY_CONFIG.allowedHosts],
                allowedOrigins: [...API_SECURITY_CONFIG.allowedOrigins],
                csrfCookieSecure: true,
            }),
        );
        await secureApp.ready();

        try {
            const response = await secureApp.inject({
                method: "GET",
                url: "/api/security/csrf",
                headers: {
                    host: "artgod.network",
                    origin: "https://artgod.network",
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.headers["set-cookie"]).toContain("Secure");
        } finally {
            await secureApp.close();
        }
    });
});

async function resolve(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    pathWithQuery: string,
    payload?: unknown,
    headers?: Record<string, string>,
): Promise<{
    statusCode: number;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
}> {
    if (!app) {
        throw new Error("Fastify app is not initialized");
    }
    return resolveWith(app, method, pathWithQuery, payload, headers);
}

async function resolvePublic(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    pathWithQuery: string,
    payload?: unknown,
    headers?: Record<string, string>,
): Promise<{
    statusCode: number;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
}> {
    if (!publicApp) {
        throw new Error("Public Fastify app is not initialized");
    }
    return resolveWith(publicApp, method, pathWithQuery, payload, headers);
}

async function resolveCached(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    pathWithQuery: string,
    payload?: unknown,
    headers?: Record<string, string>,
): Promise<{
    statusCode: number;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
}> {
    if (!cachedApp) {
        throw new Error("Cached Fastify app is not initialized");
    }
    return resolveWith(cachedApp, method, pathWithQuery, payload, headers);
}

async function resolveWith(
    targetApp: FastifyInstance,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    pathWithQuery: string,
    payload?: unknown,
    headers?: Record<string, string>,
): Promise<{
    statusCode: number;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
}> {
    const response = await targetApp.inject({
        method,
        url: pathWithQuery,
        ...(payload === undefined ? {} : { payload: payload as any }),
        ...(headers ? { headers } : {}),
    } as any);
    return {
        statusCode: response.statusCode,
        payload: response.body ? response.json() : null,
        headers: response.headers as Record<
            string,
            string | string[] | undefined
        >,
    };
}

async function issueAdminCsrf(): Promise<Record<string, string>> {
    const csrf = await resolve("GET", "/api/security/csrf", undefined, {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:5173",
    });
    if (csrf.statusCode !== 200) {
        throw new Error(`Expected CSRF token request to succeed: ${csrf.statusCode}`);
    }

    return {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:5173",
        cookie: csrf.headers["set-cookie"] as string,
        "x-artgod-csrf": csrf.payload.token as string,
    };
}

async function waitForAsyncTasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCachedHit(pathWithQuery: string): Promise<{
    statusCode: number;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
}> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await resolveCached("GET", pathWithQuery);
        if (
            response.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()] ===
            "hit"
        ) {
            return response;
        }
        await waitForAsyncTasks();
    }
    throw new Error(`Timed out waiting for cached hit: ${pathWithQuery}`);
}

function seedData(): void {
    db.exec(
        [
            "DELETE FROM activity_sources;",
            "DELETE FROM activities;",
            "DELETE FROM orders;",
            "DELETE FROM token_extension_artifacts;",
            "DELETE FROM collection_extension_installs;",
            "DELETE FROM collection_scope_tokens;",
            "DELETE FROM collection_trait_stats;",
            "DELETE FROM token_attributes;",
            "DELETE FROM attributes;",
            "DELETE FROM attribute_keys;",
            "DELETE FROM token_metadata;",
            "DELETE FROM tokens;",
            "DELETE FROM nft_balances;",
            "DELETE FROM collections;",
        ].join("\n"),
    );

    const insertCollection = db.prepare(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, bootstrap_anchor_block, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, 'contract_all_tokens', NULL, NULL, ?, ?, ?, ?)",
    );

    const miladyCollectionId = Number(
        insertCollection.run(
            1,
            "milady",
            MILADY_ADDRESS,
            "erc721",
            "live",
            1,
            null,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        ).lastInsertRowid,
    );

    const terraformsCollectionId = Number(
        insertCollection.run(
            1,
            "terraforms",
            TERRAFORMS_ADDRESS,
            "erc721",
            "bootstrapping",
            1,
            null,
            "2025-12-01T00:00:00Z",
            "2025-12-01T00:00:00Z",
        ).lastInsertRowid,
    );

    const insertToken = db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    );
    insertToken.run(1, miladyCollectionId, MILADY_ADDRESS, "1");
    insertToken.run(1, miladyCollectionId, MILADY_ADDRESS, "2");
    insertToken.run(1, miladyCollectionId, MILADY_ADDRESS, "10");
    insertToken.run(1, terraformsCollectionId, TERRAFORMS_ADDRESS, "7710");
    insertToken.run(1, terraformsCollectionId, TERRAFORMS_ADDRESS, "7711");

    const insertMetadata = db.prepare(
        "INSERT INTO token_metadata " +
            "(chain_id, collection_id, contract_address, token_id, uri, name, image, animation_url, attributes_json, raw_json, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    insertMetadata.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "1",
        "ipfs://1",
        "Milady #1",
        "https://example.com/1.png",
        "https://example.com/1.html",
        JSON.stringify([
            { traitType: "Hat", value: "Beanie" },
            { traitType: "Mood", value: "Calm" },
            { traitType: "Power", value: "7" },
        ]),
        "{}",
        "2026-01-01T00:00:00Z",
    );
    insertMetadata.run(
        1,
        terraformsCollectionId,
        TERRAFORMS_ADDRESS,
        "7710",
        "ipfs://terraforms/7710",
        "Terraform #7710",
        "https://example.com/terraforms-default.png",
        "https://example.com/terraforms-default.html",
        JSON.stringify([{ traitType: "Mode", value: "Terraform" }]),
        "{}",
        "2026-01-01T00:00:00Z",
    );
    insertMetadata.run(
        1,
        terraformsCollectionId,
        TERRAFORMS_ADDRESS,
        "7711",
        "ipfs://terraforms/7711",
        "Terrain #7711",
        "https://example.com/terraforms-terrain-default.png",
        "https://example.com/terraforms-terrain-default.html",
        JSON.stringify([{ traitType: "Mode", value: "Terrain" }]),
        "{}",
        "2026-01-01T00:00:00Z",
    );

    db.prepare(
        "INSERT INTO collection_extension_installs " +
            "(chain_id, collection_id, extension_key, enabled, config_json) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        1,
        terraformsCollectionId,
        TERRAFORMS_EXTENSION_KEY,
        1,
        JSON.stringify({
            mainContractAddress: TERRAFORMS_ADDRESS.toLowerCase(),
            rendererV2ContractAddress:
                "0x8af860c8f157f4e3b6a54913bfa6bb96ab2605c2",
            tokenUriV2ContractAddress:
                "0xfca647387e28e73e291dd90e7b09fa32bcbb2604",
            beaconV2ContractAddress:
                "0x331512a28a4cf80221af949b5d43041ff0fc7f01",
        }),
    );
    db.prepare(
        "INSERT INTO token_extension_artifacts " +
            "(chain_id, collection_id, contract_address, token_id, extension_key, artifact_ref, image, animation_url, html_content) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        terraformsCollectionId,
        TERRAFORMS_ADDRESS.toLowerCase(),
        "7710",
        TERRAFORMS_EXTENSION_KEY,
        TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
        "data:image/svg+xml;base64,terraforms-v2-image",
        "https://example.com/terraforms-v2-animation.json",
        "<html><body>terraforms-v2</body></html>",
    );
    db.prepare(
        "INSERT INTO token_extension_artifacts " +
            "(chain_id, collection_id, contract_address, token_id, extension_key, artifact_ref, image, animation_url, html_content) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        terraformsCollectionId,
        TERRAFORMS_ADDRESS.toLowerCase(),
        "7710",
        TERRAFORMS_EXTENSION_KEY,
        TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
        "data:image/svg+xml;base64,terraforms-lost-image",
        "https://example.com/terraforms-lost-animation.json",
        "<html><body>terraforms-lost</body></html>",
    );
    db.prepare(
        "INSERT INTO token_extension_artifacts " +
            "(chain_id, collection_id, contract_address, token_id, extension_key, artifact_ref, image, animation_url, html_content) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        terraformsCollectionId,
        TERRAFORMS_ADDRESS.toLowerCase(),
        "7711",
        TERRAFORMS_EXTENSION_KEY,
        TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
        "data:image/svg+xml;base64,terraforms-terrain-v2-image",
        "https://example.com/terraforms-terrain-v2-animation.json",
        "<html><body>terraforms-terrain-v2</body></html>",
    );
    insertMetadata.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "2",
        "ipfs://2",
        "Milady #2",
        "https://example.com/2.png",
        "https://example.com/2.mp4",
        JSON.stringify([
            { traitType: "Hat", value: "Beanie" },
            { traitType: "Mood", value: "Angry" },
            { traitType: "Power", value: "2" },
        ]),
        "{}",
        "2026-01-01T00:00:00Z",
    );
    insertMetadata.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "10",
        "ipfs://10",
        "Milady #10",
        "https://example.com/10.png",
        null,
        JSON.stringify([
            { traitType: "Hat", value: "Cap" },
            { traitType: "Mood", value: "Calm" },
            { traitType: "Power", value: "??" },
        ]),
        "{}",
        "2026-01-01T00:00:00Z",
    );

    const hatKeyId = insertAttributeKey("Hat");
    const moodKeyId = insertAttributeKey("Mood");
    const powerKeyId = insertAttributeKey("Power");

    const beanieId = insertAttribute(hatKeyId, "Beanie");
    const capId = insertAttribute(hatKeyId, "Cap");
    const calmId = insertAttribute(moodKeyId, "Calm");
    const angryId = insertAttribute(moodKeyId, "Angry");
    const powerSevenId = insertAttribute(powerKeyId, "7");
    const powerTwoId = insertAttribute(powerKeyId, "2");
    const powerUnknownId = insertAttribute(powerKeyId, "??");

    const insertTokenAttribute = db.prepare(
        "INSERT INTO token_attributes (chain_id, collection_id, contract_address, token_id, attribute_id) VALUES (?, ?, ?, ?, ?)",
    );

    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "1",
        beanieId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "1",
        calmId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "1",
        powerSevenId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "2",
        beanieId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "2",
        angryId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "2",
        powerTwoId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "10",
        capId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "10",
        calmId,
    );
    insertTokenAttribute.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        "10",
        powerUnknownId,
    );

    const insertTraitStats = db.prepare(
        "INSERT INTO collection_trait_stats (chain_id, collection_id, contract_address, attribute_key_id, attribute_id, token_count) VALUES (?, ?, ?, ?, ?, ?)",
    );

    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        hatKeyId,
        beanieId,
        2,
    );
    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        hatKeyId,
        capId,
        1,
    );
    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        moodKeyId,
        calmId,
        2,
    );
    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        moodKeyId,
        angryId,
        1,
    );
    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        powerKeyId,
        powerSevenId,
        1,
    );
    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        powerKeyId,
        powerTwoId,
        1,
    );
    insertTraitStats.run(
        1,
        miladyCollectionId,
        MILADY_ADDRESS,
        powerKeyId,
        powerUnknownId,
        1,
    );

    insertOrderFixture({
        id: "listed-milady-1-cheapest",
        side: "sell",
        contract: MILADY_ADDRESS,
        tokenId: "1",
        sourceScopeKind: "token",
        price: "500000000000000000",
        currency: ZERO_ADDRESS,
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
    });
    insertOrderFixture({
        id: "listed-milady-1-higher",
        side: "sell",
        contract: MILADY_ADDRESS,
        tokenId: "1",
        sourceScopeKind: "token",
        price: "750000000000000000",
        currency: WETH_ADDRESS,
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
    });
    insertOrderFixture({
        id: "listed-milady-10",
        side: "sell",
        contract: MILADY_ADDRESS,
        tokenId: "10",
        sourceScopeKind: "token",
        price: "1200000000000000000",
        currency: WETH_ADDRESS,
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
    });
    insertOrderFixture({
        id: "unsupported-currency-token-2",
        side: "sell",
        contract: MILADY_ADDRESS,
        tokenId: "2",
        sourceScopeKind: "token",
        price: "1000000",
        currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
    });
    insertOrderFixture({
        id: "inactive-token-2",
        side: "sell",
        contract: MILADY_ADDRESS,
        tokenId: "2",
        sourceScopeKind: "token",
        price: "200000000000000000",
        currency: ZERO_ADDRESS,
        sourceStatus: "inactive",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
    });
    insertOrderFixture({
        id: "buy-order-token-2",
        side: "buy",
        contract: MILADY_ADDRESS,
        tokenId: "2",
        sourceScopeKind: "token",
        price: "300000000000000000",
        currency: WETH_ADDRESS,
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
        rawRestData: makeOpenSeaBuyOrderPayload({
            orderId: "buy-order-token-2",
            contract: MILADY_ADDRESS,
            tokenId: "2",
            priceWei: "300000000000000000",
            validFrom: 1_700_000_000,
            validUntil: 1_900_000_000,
        }),
    });
    insertOrderFixture({
        id: "collection-offer",
        side: "buy",
        contract: MILADY_ADDRESS,
        tokenId: null,
        sourceScopeKind: "collection",
        price: "900000000000000000",
        currency: WETH_ADDRESS,
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_700_000_000,
        validUntil: 1_900_000_000,
        rawRestData: makeOpenSeaBuyOrderPayload({
            orderId: "collection-offer",
            contract: MILADY_ADDRESS,
            priceWei: "900000000000000000",
            validFrom: 1_700_000_000,
            validUntil: 1_900_000_000,
        }),
    });
    insertOrderFixture({
        id: "expired-listing-token-2",
        side: "sell",
        contract: MILADY_ADDRESS,
        tokenId: "2",
        sourceScopeKind: "token",
        price: "100000000000000000",
        currency: ZERO_ADDRESS,
        sourceStatus: "active",
        fillabilityStatus: "fillable",
        validFrom: 1_600_000_000,
        validUntil: 1_600_000_100,
    });

    insertActivityFixture({
        collectionAddress: MILADY_ADDRESS,
        scopeKind: ACTIVITY_SCOPE_KIND.Token,
        kind: ACTIVITY_KIND.Sale,
        tokenId: "1",
        occurredAt: 1_726_000_400,
        sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
        sourceName: "seaport",
        orderId: "listed-milady-1-cheapest",
        blockNumber: 22_000_100,
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 3,
        from: "0x9999999999999999999999999999999999999999",
        to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        maker: "0x9999999999999999999999999999999999999999",
        taker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        side: "sell",
        amount: "1",
        price: "500000000000000000",
        currency: ZERO_ADDRESS,
        dedupeKey:
            "onchain:sale:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:3:1",
    });
    insertActivityFixture({
        collectionAddress: MILADY_ADDRESS,
        scopeKind: ACTIVITY_SCOPE_KIND.Token,
        kind: ACTIVITY_KIND.Transfer,
        tokenId: "1",
        occurredAt: 1_726_000_300,
        sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
        sourceName: "onchain",
        blockNumber: 22_000_100,
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 2,
        from: "0x9999999999999999999999999999999999999999",
        to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        amount: "1",
        dedupeKey:
            "onchain:transfer:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2:1",
    });
    insertActivityFixture({
        collectionAddress: MILADY_ADDRESS,
        scopeKind: ACTIVITY_SCOPE_KIND.Token,
        kind: ACTIVITY_KIND.ListingCancelled,
        tokenId: "1",
        occurredAt: 1_726_000_250,
        sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
        sourceName: "opensea",
        orderId: "listed-milady-1-cheapest",
        maker: "0x9999999999999999999999999999999999999999",
        side: "sell",
        price: "500000000000000000",
        currency: ZERO_ADDRESS,
        payload: {
            eventType: "item_cancelled",
        },
        dedupeKey: "offchain:opensea:item_cancelled:listed-milady-1-cheapest:1",
    });
    insertActivityFixture({
        collectionAddress: MILADY_ADDRESS,
        scopeKind: ACTIVITY_SCOPE_KIND.Token,
        kind: ACTIVITY_KIND.ListingCreated,
        tokenId: "1",
        occurredAt: 1_726_000_200,
        sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
        sourceName: "opensea",
        orderId: "listed-milady-1-cheapest",
        maker: "0x9999999999999999999999999999999999999999",
        side: "sell",
        price: "500000000000000000",
        currency: ZERO_ADDRESS,
        payload: {
            eventType: "item_listed",
        },
        dedupeKey: "offchain:opensea:item_listed:listed-milady-1-cheapest:1",
        isOpen: true,
    });
    insertActivityFixture({
        collectionAddress: MILADY_ADDRESS,
        scopeKind: ACTIVITY_SCOPE_KIND.Token,
        kind: ACTIVITY_KIND.BidCreated,
        tokenId: "2",
        occurredAt: 1_726_000_100,
        sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
        sourceName: "opensea",
        orderId: "buy-order-token-2",
        maker: "0x9999999999999999999999999999999999999999",
        side: "buy",
        price: "300000000000000000",
        currency: WETH_ADDRESS,
        payload: {
            eventType: "item_received_bid",
        },
        dedupeKey: "offchain:opensea:item_received_bid:buy-order-token-2:2",
        isOpen: true,
    });
}

function clearTradingJobFixtures(): void {
    db.exec(
        [
            "DELETE FROM trading_bidding_bid_book_rows;",
            "DELETE FROM trading_bidding_collection_bid_book_state;",
            "DELETE FROM trading_bot_runtime_state;",
            "DELETE FROM trading_job_commands;",
            "DELETE FROM trading_bidding_job_runtime_state;",
            "DELETE FROM trading_bidding_job_specs;",
            "DELETE FROM trading_jobs;",
        ].join("\n"),
    );
}

function listTradingCommandKinds(): string[] {
    const rows = db
        .prepare("SELECT command_kind FROM trading_job_commands ORDER BY command_id ASC")
        .all() as { command_kind: string }[];
    return rows.map((row) => row.command_kind);
}

function insertActivityFixture(input: {
    collectionAddress: string;
    scopeKind: "token" | "collection" | "attribute";
    kind: string;
    tokenId: string | null;
    occurredAt: number;
    sourceKind: "onchain" | "offchain" | "extension";
    sourceName: string;
    orderId?: string | null;
    blockNumber?: number | null;
    txHash?: string | null;
    logIndex?: number | null;
    from?: string | null;
    to?: string | null;
    maker?: string | null;
    taker?: string | null;
    side?: "buy" | "sell" | null;
    amount?: string | null;
    price?: string | null;
    currency?: string | null;
    payload?: Record<string, unknown> | null;
    dedupeKey: string;
    isOpen?: boolean;
}): void {
    const collection = getCollectionFixtureByAddress(input.collectionAddress);
    db.prepare(
        "INSERT INTO activities " +
            "(chain_id, collection_id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, dedupe_key, is_open, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).run(
        1,
        collection.collection_id,
        input.scopeKind,
        input.kind,
        input.collectionAddress.toLowerCase(),
        input.tokenId,
        input.occurredAt,
        input.sourceKind,
        input.sourceName,
        input.orderId ?? null,
        input.blockNumber ?? null,
        input.txHash ?? null,
        input.logIndex ?? null,
        input.from?.toLowerCase() ?? null,
        input.to?.toLowerCase() ?? null,
        input.maker?.toLowerCase() ?? null,
        input.taker?.toLowerCase() ?? null,
        input.side ?? null,
        input.amount ?? null,
        input.price ?? null,
        input.currency?.toLowerCase() ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        input.dedupeKey,
        input.isOpen ? 1 : 0,
    );
}

function insertOrderFixture(input: {
    id: string;
    side: "buy" | "sell";
    contract: string;
    tokenId: string | null;
    sourceScopeKind: "token" | "collection" | "attribute" | "token_set";
    price: string;
    currency: string;
    sourceStatus:
        | "active"
        | "inactive"
        | "cancelled"
        | "filled"
        | "invalidated"
        | "expired"
        | "unknown";
    fillabilityStatus:
        | "fillable"
        | "filled"
        | "cancelled"
        | "expired"
        | "no-balance"
        | "no-approval"
        | "invalid";
    validFrom: number;
    validUntil: number;
    sourceSchemaJson?: unknown;
    rawRestData?: unknown;
    rawStreamData?: unknown;
}): void {
    const collection = getCollectionFixtureByAddress(input.contract);
    db.prepare(
        "INSERT INTO orders " +
            "(id, chain_id, collection_id, kind, side, source, maker, taker, contract_address, token_id, source_scope_kind, source_schema_json, price, currency, valid_from, valid_until, fillability_status, source_status, raw_rest_data, raw_stream_data, created_at, updated_at) " +
            "VALUES (?, 1, ?, 'seaport', ?, 'opensea', '0x9999999999999999999999999999999999999999', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).run(
        input.id,
        collection.collection_id,
        input.side,
        input.contract.toLowerCase(),
        input.tokenId,
        input.sourceScopeKind,
        input.sourceSchemaJson ? JSON.stringify(input.sourceSchemaJson) : null,
        input.price,
        input.currency.toLowerCase(),
        input.validFrom,
        input.validUntil,
        input.fillabilityStatus,
        input.sourceStatus,
        input.rawRestData ? JSON.stringify(input.rawRestData) : null,
        input.rawStreamData ? JSON.stringify(input.rawStreamData) : null,
    );
}

function makeOpenSeaBuyOrderPayload(input: {
    orderId: string;
    contract: string;
    priceWei: string;
    maker?: string;
    tokenId?: string;
    traits?: Array<{ type: string; value: string }>;
    quantity?: number;
    validFrom: number;
    validUntil: number;
}): unknown {
    const maker = input.maker ?? "0x9999999999999999999999999999999999999999";
    const quantity = input.quantity ?? 1;
    const itemType = input.tokenId ? 2 : 4;
    const identifierOrCriteria = input.tokenId ?? "0";

    return {
        order_hash: input.orderId,
        protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
        maker: { address: maker },
        created_at: new Date(input.validFrom * 1000).toISOString(),
        expiration_time: input.validUntil,
        remaining_quantity: quantity,
        protocol_data: {
            parameters: {
                offerer: maker,
                offer: [
                    {
                        itemType: 1,
                        token: WETH_ADDRESS,
                        identifierOrCriteria: "0",
                        startAmount: (
                            BigInt(input.priceWei) * BigInt(quantity)
                        ).toString(),
                        endAmount: (
                            BigInt(input.priceWei) * BigInt(quantity)
                        ).toString(),
                    },
                ],
                consideration: [
                    {
                        itemType,
                        token: input.contract,
                        identifierOrCriteria,
                        startAmount: String(quantity),
                        endAmount: String(quantity),
                        recipient: maker,
                    },
                ],
                orderType: 3,
                startTime: String(input.validFrom),
                endTime: String(input.validUntil),
            },
        },
        criteria: input.tokenId
            ? null
            : {
                  collection: { slug: "milady" },
                  contract: { address: input.contract },
                  trait: null,
                  traits: input.traits ?? null,
                  numeric_traits: null,
                  encoded_token_ids: "*",
              },
    };
}

function insertBootstrapRun(input: {
    chainId: number;
    collectionAddress: string;
    status:
        | "requested"
        | "queued"
        | "metadata"
        | "ownership"
        | "backfill"
        | "completed"
        | "failed";
    metadataMode: "strict" | "best_effort";
    anchorBlock: number | null;
    anchorBlockHash: string | null;
    anchorBlockTimestamp: number | null;
}): number {
    const collection = getCollectionFixtureByAddress(
        input.collectionAddress,
        input.chainId,
    );

    db.prepare(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, deployment_block, status, anchor_block, anchor_block_hash, anchor_block_timestamp, error_code, error_message, created_at, updated_at, finished_at) " +
            "VALUES (?, ?, ?, ?, 'erc721', ?, 'enumerable', NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
    ).run(
        input.chainId,
        collection.collection_id,
        collection.slug,
        collection.address.toLowerCase(),
        input.metadataMode,
        input.status,
        input.anchorBlock,
        input.anchorBlockHash,
        input.anchorBlockTimestamp,
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        input.status === "completed" || input.status === "failed"
            ? "2026-02-01T00:01:00Z"
            : null,
    );

    const row = db
        .prepare<
            [number, number]
        >("SELECT run_id FROM bootstrap_runs WHERE chain_id = ? AND collection_id = ? ORDER BY run_id DESC LIMIT 1")
        .get(input.chainId, collection.collection_id) as
        | { run_id: number }
        | undefined;
    if (!row) {
        throw new Error("Failed to resolve inserted bootstrap run");
    }
    return row.run_id;
}

function insertNftBalance(
    contractAddress: string,
    tokenId: string,
    owner: string,
    amount: string,
): void {
    const collection = getCollectionFixtureByAddress(contractAddress);
    db.prepare(
        "INSERT OR REPLACE INTO nft_balances " +
            "(chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    ).run(
        1,
        collection.collection_id,
        contractAddress.toLowerCase(),
        tokenId,
        owner.toLowerCase(),
        amount,
        1,
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        1_726_000_000,
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        0,
    );
}

function clearNftBalances(contractAddress: string): void {
    db.prepare(
        "DELETE FROM nft_balances WHERE chain_id = ? AND collection_id = ?",
    ).run(1, getCollectionFixtureByAddress(contractAddress).collection_id);
}

function insertBootstrapMetadataTask(
    runId: number,
    tokenId: string,
    status: "pending" | "retry" | "succeeded" | "failed_terminal",
): void {
    const run = db
        .prepare<
            [number]
        >("SELECT r.chain_id, r.collection_id, c.address, r.request_standard, r.anchor_block, r.anchor_block_hash, r.anchor_block_timestamp " + "FROM bootstrap_runs r " + "JOIN collections c ON c.chain_id = r.chain_id AND c.collection_id = r.collection_id " + "WHERE r.run_id = ? LIMIT 1")
        .get(runId) as
        | {
              chain_id: number;
              collection_id: number;
              address: string;
              request_standard: string;
              anchor_block: number | null;
              anchor_block_hash: string | null;
              anchor_block_timestamp: number | null;
          }
        | undefined;
    if (
        !run ||
        run.anchor_block === null ||
        !run.anchor_block_hash ||
        run.anchor_block_timestamp === null
    ) {
        throw new Error(
            "Missing run anchor data for metadata task fixture insertion",
        );
    }

    db.prepare(
        "INSERT INTO bootstrap_metadata_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at, last_error, last_error_at, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).run(
        runId,
        run.chain_id,
        run.collection_id,
        run.address.toLowerCase(),
        tokenId,
        run.request_standard,
        run.anchor_block,
        run.anchor_block_hash,
        run.anchor_block_timestamp,
        status,
    );
}

function insertBootstrapRunEvent(
    runId: number,
    eventCode: string,
    eventLevel: "info" | "warn" | "error" = "info",
): void {
    const run = db
        .prepare<
            [number]
        >("SELECT chain_id, collection_id FROM bootstrap_runs WHERE run_id = ? LIMIT 1")
        .get(runId) as
        | {
              chain_id: number;
              collection_id: number;
          }
        | undefined;
    if (!run) {
        throw new Error("Missing bootstrap run for event fixture insertion");
    }

    db.prepare(
        "INSERT INTO bootstrap_run_events " +
            "(run_id, chain_id, collection_id, event_code, event_level, message, payload_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)",
    ).run(
        runId,
        run.chain_id,
        run.collection_id,
        eventCode,
        eventLevel,
        eventCode,
    );
}

function updateCollectionLifecycle(
    collectionAddress: string,
    input: {
        status?: "bootstrapping" | "live" | "paused" | "disabled";
        bootstrapFinishedAt?: string | null;
        bootstrapLastSyncedBlock?: number | null;
        openseaSlug?: string | null;
        openseaStatus?:
            | "pending"
            | "identity_running"
            | "subscribing"
            | "snapshot_pending"
            | "snapshot_running"
            | "ready"
            | "retrying"
            | "failed"
            | null;
        openseaReadyAt?: string | null;
        openseaSnapshotStartedAt?: string | null;
        openseaSnapshotCompletedAt?: string | null;
        openseaLastError?: string | null;
    },
): void {
    db.prepare(
        "UPDATE collections SET " +
            "status = COALESCE(?, status), " +
            "bootstrap_finished_at = COALESCE(?, bootstrap_finished_at), " +
            "bootstrap_last_synced_block = COALESCE(?, bootstrap_last_synced_block), " +
            "opensea_slug = COALESCE(?, opensea_slug), " +
            "opensea_status = COALESCE(?, opensea_status), " +
            "opensea_ready_at = COALESCE(?, opensea_ready_at), " +
            "opensea_snapshot_started_at = COALESCE(?, opensea_snapshot_started_at), " +
            "opensea_snapshot_completed_at = COALESCE(?, opensea_snapshot_completed_at), " +
            "opensea_last_error = ?, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = 1 AND lower(address) = ?",
    ).run(
        input.status ?? null,
        input.bootstrapFinishedAt ?? null,
        input.bootstrapLastSyncedBlock ?? null,
        input.openseaSlug ?? null,
        input.openseaStatus ?? null,
        input.openseaReadyAt ?? null,
        input.openseaSnapshotStartedAt ?? null,
        input.openseaSnapshotCompletedAt ?? null,
        input.openseaLastError ?? null,
        collectionAddress.toLowerCase(),
    );
}

function insertAttributeKey(key: string): number {
    const collection = getCollectionFixtureByAddress(MILADY_ADDRESS);
    db.prepare(
        "INSERT INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (?, ?, ?, ?)",
    ).run(1, collection.collection_id, MILADY_ADDRESS, key);

    const row = db
        .prepare<
            [number, number, string]
        >("SELECT id FROM attribute_keys WHERE chain_id = ? AND collection_id = ? AND key = ?")
        .get(1, collection.collection_id, key) as { id: number } | undefined;
    if (!row) throw new Error(`Missing attribute key: ${key}`);
    return row.id;
}

function insertAttribute(attributeKeyId: number, value: string): number {
    const collection = getCollectionFixtureByAddress(MILADY_ADDRESS);
    db.prepare(
        "INSERT INTO attributes (chain_id, collection_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?, ?)",
    ).run(1, collection.collection_id, MILADY_ADDRESS, attributeKeyId, value);

    const row = db
        .prepare<
            [number, number, number, string]
        >("SELECT id FROM attributes WHERE chain_id = ? AND collection_id = ? AND attribute_key_id = ? AND value = ?")
        .get(1, collection.collection_id, attributeKeyId, value) as
        | { id: number }
        | undefined;
    if (!row) throw new Error(`Missing attribute: ${value}`);
    return row.id;
}

function getCollectionFixtureByAddress(
    address: string,
    chainId: number = 1,
): { collection_id: number; slug: string; address: string } {
    const row = db
        .prepare<
            [number, string]
        >("SELECT collection_id, slug, address FROM collections WHERE chain_id = ? AND lower(address) = ? LIMIT 1")
        .get(chainId, address.toLowerCase()) as
        | { collection_id: number; slug: string; address: string }
        | undefined;
    if (!row) {
        throw new Error(`Missing collection fixture for ${address}`);
    }
    return row;
}
