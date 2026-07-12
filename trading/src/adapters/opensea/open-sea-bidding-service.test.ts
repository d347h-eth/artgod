import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TokenMetadataRepository,
    type TokenMetadataTrait,
} from "../../domain/market/token-metadata-repository.js";
import { BIDDER_TARGET_TYPE } from "../../domain/market/strategy/job.js";
import {
    createCollectionOfferSnapshotMetrics,
    type CollectionOfferSnapshot,
    type CollectionOfferSnapshotProvider,
} from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    BIDDING_ORDER_RECOVERY_REASON,
    BIDDING_ORDER_RECOVERY_STATUS,
    BIDDING_SERVICE_REQUEST_PRIORITY,
} from "../../application/use-cases/bidding/bidding-service.js";
import { TOKEN_BUCKET_RATE_LIMIT_PRIORITY } from "../support/token-bucket-rate-limiter.js";
import {
    isRetryableOpenSeaBiddingError,
    OPENSEA_SIGNED_ZONE_TRAIT_TRUST_REQUIRED_ERROR,
    OpenSeaBiddingService,
} from "./open-sea-bidding-service.js";
import {
    OpenSeaApiClient,
    OpenSeaBiddingSdkClient,
    OpenSeaCreateCollectionOfferInput,
    OpenSeaCreateCollectionOfferResponse,
    OpenSeaCreateOfferInput,
    OpenSeaCreateOfferResponse,
    OpenSeaOffersPage,
} from "./open-sea-client.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const TEST_RETRY_POLICY = {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
};
const TEST_MULTI_ATTEMPT_RETRY_POLICY = {
    maxAttempts: 5,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
};
const TEST_OPENSEA_NFT_NOT_FOUND_ERROR =
    "Server Error: NFT with identifier unminted-tile-5785 not found in collection terraforms";

class MockOpenSeaSdk implements OpenSeaBiddingSdkClient {
    public api: OpenSeaApiClient = {
        getOffersByNFT: async (
            _slug: string,
            _tokenId: string,
            _limit?: number,
            _next?: string,
        ): Promise<OpenSeaOffersPage> => ({ offers: [] }),
        getAllOffers: async (
            _slug: string,
            _limit?: number,
            _next?: string,
        ): Promise<OpenSeaOffersPage> => ({ offers: [] }),
        getOrderByHash: async (
            _orderHash: string,
            _protocolAddress: string,
        ): Promise<unknown> => {
            throw new Error("not implemented");
        },
        getCollectionOffers: async (
            _slug: string,
            _limit?: number,
            _next?: string,
        ): Promise<OpenSeaOffersPage> => ({ offers: [] }),
        getTraitOffers: async (
            _slug: string,
            _type: string,
            _value: string,
            _limit?: number,
            _next?: string,
        ): Promise<OpenSeaOffersPage> => ({ offers: [] }),
        getTraits: async (_slug: string): Promise<{ counts: {} }> => ({
            counts: {},
        }),
        getBestOffer: async (_slug: string, _tokenId: string) => null,
    };

    public async createCollectionOffer(
        _input: OpenSeaCreateCollectionOfferInput,
    ): Promise<OpenSeaCreateCollectionOfferResponse | null> {
        return null;
    }

    public async createOffer(
        _input: OpenSeaCreateOfferInput,
    ): Promise<OpenSeaCreateOfferResponse> {
        return {};
    }

    public async offchainCancelOrder(
        _protocolAddress: string,
        _orderHash: string,
        _chain?: string,
        _offererSignature?: string,
        _useSignerToDeriveOffererSignature?: boolean,
    ): Promise<void> {
        return;
    }
}

type RawTestCollectionOfferSnapshot = Omit<
    CollectionOfferSnapshot,
    "metrics"
> & {
    metrics?: CollectionOfferSnapshot["metrics"];
};

class FakeCollectionOfferSnapshotProvider implements CollectionOfferSnapshotProvider {
    constructor(
        private readonly snapshots: Record<
            string,
            RawTestCollectionOfferSnapshot
        >,
    ) {}

    public getSnapshot(collectionSlug: string): CollectionOfferSnapshot | null {
        const snapshot = this.snapshots[collectionSlug];
        if (!snapshot) {
            return null;
        }

        return {
            ...snapshot,
            metrics:
                snapshot.metrics ??
                createCollectionOfferSnapshotMetrics({
                    offerCount: snapshot.offers.length,
                }),
        };
    }
}

class FakeTokenMetadataRepository implements TokenMetadataRepository {
    constructor(private readonly rows: Record<string, TokenMetadataTrait[]>) {}

    async getTraits(
        collectionSlug: string,
        tokenId: string,
    ): Promise<TokenMetadataTrait[]> {
        return this.rows[`${collectionSlug}:${tokenId}`] ?? [];
    }
}

function makeOffer(
    id: string,
    maker: string,
    priceWei: string,
    collectionAddress: string,
    criteria?: unknown,
    itemType: number = 4,
) {
    return {
        order_hash: id,
        maker: { address: maker },
        protocol_address: "0xprotocol",
        protocol_data: {
            parameters: {
                offer: [{ token: WETH, startAmount: priceWei }],
                consideration: [
                    {
                        itemType,
                        token: collectionAddress,
                        startAmount: "1",
                    },
                ],
            },
        },
        criteria,
    };
}

describe("OpenSeaBiddingService", () => {
    const makerAddress = "0xmaker";
    const collectionSlug = "sluggy";
    const collectionAddress = "0xcollection";
    const protocolAddress = "0xprotocol";
    const orderHash = "0xhash";

    it("classifies permanent OpenSea target errors as non-retryable", () => {
        assert.equal(
            isRetryableOpenSeaBiddingError(
                new Error(TEST_OPENSEA_NFT_NOT_FOUND_ERROR),
            ),
            false,
        );
        assert.equal(
            isRetryableOpenSeaBiddingError(new Error("network unavailable")),
            true,
        );
    });

    it("places collection offers with expiration and quantity-aware totals", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_RETRY_POLICY,
        });
        const job = {
            id: "job-1",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 2,
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        sdk.createCollectionOffer = async (input: any) => {
            assert.equal(input.collectionSlug, collectionSlug);
            assert.equal(input.accountAddress, makerAddress);
            assert.equal(input.amount, "2");
            assert.equal(input.quantity, 2);
            const now = Math.floor(Date.now() / 1000);
            const expected = now + (3 * 60 + 52) * 60;
            assert.ok(
                input.expirationTime >= expected - 60 &&
                    input.expirationTime <= expected + 60,
            );

            return {
                order_hash: orderHash,
                protocol_address: protocolAddress,
                expiration_time: input.expirationTime,
            };
        };

        const beforePlaceMs = Date.now();
        const result = await service.placeOffer(job, 1_000000000000000000n);
        const afterPlaceMs = Date.now();

        assert.equal(result.orderHash, orderHash);
        assert.equal(result.protocolAddress, protocolAddress);
        assert.ok(Date.parse(result.placedAt) >= beforePlaceMs);
        assert.ok(Date.parse(result.placedAt) <= afterPlaceMs);
        assert.ok(result.expirationTime !== undefined);
    });

    it("passes command priority into OpenSea rate limiting", async () => {
        const sdk = new MockOpenSeaSdk();
        const waits: Array<{
            getCost: number;
            postCost: number;
            priority: number | undefined;
        }> = [];
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_RETRY_POLICY,
            rateLimiter: {
                wait: async (
                    getCost: number,
                    postCost: number,
                    options?: { priority?: number },
                ) => {
                    waits.push({
                        getCost,
                        postCost,
                        priority: options?.priority,
                    });
                },
            } as any,
        });
        const job = {
            id: "job-priority",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        sdk.createOffer = async () => ({
            order_hash: orderHash,
            protocol_address: protocolAddress,
        });

        await service.placeOffer(job, 1_000000000000000000n, {
            priority: BIDDING_SERVICE_REQUEST_PRIORITY.UserCommand,
        });

        assert.deepEqual(waits, [
            {
                getCost: 1,
                postCost: 2,
                priority: TOKEN_BUCKET_RATE_LIMIT_PRIORITY.UserCommand,
            },
        ]);
    });

    it("blocks trait placement before the SDK unless SignedZone trust is explicitly enabled", async () => {
        const sdk = new MockOpenSeaSdk();
        let sdkCalls = 0;
        sdk.createCollectionOffer = async () => {
            sdkCalls += 1;
            return null;
        };
        const service = new OpenSeaBiddingService(sdk, makerAddress);
        const traitJob = {
            id: "job-trait-disabled",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Outfit", value: "Kimono" },
                competitorTraits: [],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        await assert.rejects(
            () => service.placeOffer(traitJob, 1_000000000000000000n),
            new RegExp(OPENSEA_SIGNED_ZONE_TRAIT_TRUST_REQUIRED_ERROR),
        );
        assert.equal(sdkCalls, 0);
    });

    it("places competitive-trait and multi-trait collection offers after explicit SignedZone trust", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            trustOpenSeaSignedZoneTraitOffers: true,
        });

        const competitiveTraitJob = {
            id: "job-ct",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Outfit", value: "Kimono" },
                competitorTraits: [{ type: "Background" }],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        const multiTraitJob = {
            id: "job-mt",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
                traits: [
                    { type: "Biome", value: "81" },
                    { type: "Mode", value: "Terrain" },
                ],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        const inputs: any[] = [];
        sdk.createCollectionOffer = async (input: any) => {
            inputs.push(input);
            return {
                order_hash: orderHash,
                protocol_address: protocolAddress,
                expiration_time: input.expirationTime,
            };
        };

        await service.placeOffer(competitiveTraitJob, 1_000000000000000000n);
        await service.placeOffer(multiTraitJob, 1_000000000000000000n);

        assert.equal(inputs[0].traitType, "Outfit");
        assert.equal(inputs[0].traitValue, "Kimono");
        assert.equal(inputs[0].traits, undefined);
        assert.deepEqual(inputs[1].traits, [
            { type: "Biome", value: "81" },
            { type: "Mode", value: "Terrain" },
        ]);
        assert.equal(inputs[1].traitType, undefined);
        assert.equal(inputs[1].traitValue, undefined);
    });

    it("places token offers with unit amount and returns expiration", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const job = {
            id: "job-token",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        sdk.createOffer = async (input: any) => {
            assert.equal(input.asset.tokenAddress, collectionAddress);
            assert.equal(input.asset.tokenId, "123");
            assert.equal(input.amount, "1");
            return {
                orderHash,
                protocolAddress,
                expirationTime: input.expirationTime,
            };
        };

        const beforePlaceMs = Date.now();
        const result = await service.placeOffer(job, 1_000000000000000000n);
        const afterPlaceMs = Date.now();

        assert.equal(result.orderHash, orderHash);
        assert.equal(result.protocolAddress, protocolAddress);
        assert.ok(Date.parse(result.placedAt) >= beforePlaceMs);
        assert.ok(Date.parse(result.placedAt) <= afterPlaceMs);
        assert.ok(result.expirationTime !== undefined);
    });

    it("rejects placed offers without a complete OpenSea order identity", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const tokenJob = {
            id: "job-token",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        const collectionJob = {
            id: "job-collection",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Collection, quantity: 1 },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        sdk.createOffer = async () => ({
            orderHash: "",
            protocolAddress,
        });
        await assert.rejects(
            () => service.placeOffer(tokenJob, 1_000000000000000000n),
            /missing order hash/,
        );

        sdk.createCollectionOffer = async () => ({
            order_hash: orderHash,
            protocol_address: "   ",
        });
        await assert.rejects(
            () => service.placeOffer(collectionJob, 1_000000000000000000n),
            /missing protocol address/,
        );
    });

    it("cancels offers via offchainCancelOrder and requires protocol address", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const calls: unknown[][] = [];

        sdk.offchainCancelOrder = async (...args: unknown[]) => {
            calls.push(args);
        };

        await service.cancelOffer({} as any, {
            id: orderHash,
            maker: makerAddress,
            price: 1n,
            protocolAddress,
        });

        assert.deepEqual(calls, [
            [protocolAddress, orderHash, "ethereum", undefined, true],
        ]);
    });

    it("recovers an order directly by hash and drops inactive direct lookups", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);

        sdk.api.getOrderByHash = async () => ({
            order_hash: orderHash,
            status: "ACTIVE",
            maker: { address: makerAddress },
            protocol_address: protocolAddress,
            protocol_data: {
                parameters: {
                    offer: [{ token: WETH, amount: "1000000000000000000" }],
                    consideration: [
                        {
                            token: collectionAddress,
                            identifierOrCriteria: "123",
                            amount: "1",
                            itemType: 2,
                        },
                    ],
                },
            },
        });

        const active = await service.getOrder(
            orderHash,
            protocolAddress,
            collectionAddress,
        );
        assert.equal(active.status, BIDDING_ORDER_RECOVERY_STATUS.Active);
        assert.equal(
            active.status === BIDDING_ORDER_RECOVERY_STATUS.Active
                ? active.order.id
                : null,
            orderHash,
        );

        sdk.api.getOrderByHash = async () => ({
            order_hash: orderHash,
            status: "CANCELLED",
            maker: { address: makerAddress },
            protocol_data: {
                parameters: {
                    offer: [{ token: WETH, amount: "1000000000000000000" }],
                    consideration: [{ itemType: 2, token: collectionAddress }],
                },
            },
        });

        const inactive = await service.getOrder(
            orderHash,
            protocolAddress,
            collectionAddress,
        );
        assert.equal(
            inactive.status,
            BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
        );
    });

    it("returns inconclusive order recovery when direct lookup fails without scanning collection offers", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_RETRY_POLICY,
        });
        let collectionScanCalls = 0;

        sdk.api.getOrderByHash = async () => {
            throw new Error("OpenSea unavailable");
        };
        sdk.api.getAllOffers = async () => {
            collectionScanCalls += 1;
            throw new Error("unused");
        };

        const recovered = await service.getOrder(
            orderHash,
            protocolAddress,
            collectionAddress,
            undefined,
            collectionSlug,
        );

        assert.deepEqual(recovered, {
            status: BIDDING_ORDER_RECOVERY_STATUS.Inconclusive,
            reason: BIDDING_ORDER_RECOVERY_REASON.DirectLookupFailed,
        });
        assert.equal(collectionScanCalls, 0);
    });

    it("treats direct order-not-found as absent without scanning collection offers", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_RETRY_POLICY,
        });
        let collectionScanCalls = 0;

        sdk.api.getOrderByHash = async () => {
            throw new Error("Order not found");
        };
        sdk.api.getAllOffers = async () => {
            collectionScanCalls += 1;
            throw new Error("unused");
        };

        const recovered = await service.getOrder(
            orderHash,
            protocolAddress,
            collectionAddress,
            undefined,
            collectionSlug,
        );

        assert.deepEqual(recovered, {
            status: BIDDING_ORDER_RECOVERY_STATUS.InactiveOrMissing,
        });
        assert.equal(collectionScanCalls, 0);
    });

    it("queries maker-specific token offers and returns the best parsed order", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const job = {
            id: "job-maker",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        sdk.api.getOffersByNFT = async (slug, tokenId, limit, next) => {
            assert.equal(slug, collectionSlug);
            assert.equal(tokenId, "123");
            assert.equal(limit, 100);
            assert.equal(next, undefined);
            return {
                offers: [
                    {
                        orderHash: "0xother",
                        maker: { address: "0xother" },
                        protocolAddress,
                        currentPrice: "2000000000000000000",
                        expirationTime: 1234567890,
                        paymentToken: WETH,
                    },
                    {
                        orderHash,
                        maker: { address: "0xmaker" },
                        protocolAddress,
                        currentPrice: "1000000000000000000",
                        expirationTime: 1234567890,
                        paymentToken: WETH,
                    },
                ],
            };
        };

        const result = await service.getActiveTokenOfferByMaker(job, "0xmaker");

        assert.ok(result);
        assert.equal(result?.id, orderHash);
        assert.equal(result?.maker, "0xmaker");
        assert.equal(result?.price, 1_000000000000000000n);
        assert.equal(result?.expirationTime, 1234567890);
    });

    it("does not retry permanent OpenSea token-target errors", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_MULTI_ATTEMPT_RETRY_POLICY,
        });
        const job = {
            id: "job-permanent-error",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "unminted-tile-5785" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        let calls = 0;
        sdk.api.getOffersByNFT = async () => {
            calls++;
            throw new Error(TEST_OPENSEA_NFT_NOT_FOUND_ERROR);
        };

        await assert.rejects(
            () => service.getActiveOffers(job),
            /NFT with identifier unminted-tile-5785 not found/,
        );

        assert.equal(calls, 1);
    });

    it("includes collection-wide and expanded competitive-trait buckets", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const job = {
            id: "job-competitive",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Outfit", value: "Kimono" },
                competitorTraits: [{ type: "Background" }],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        const traitRequests: string[] = [];

        sdk.api.getCollectionOffers = async () => ({
            offers: [
                makeOffer(
                    "0xcollectionwide",
                    "0xother1",
                    "100000000000000000",
                    collectionAddress,
                    { encoded_token_ids: "*" },
                ),
                makeOffer(
                    "0xignored-in-collection-page",
                    "0xother2",
                    "200000000000000000",
                    collectionAddress,
                    { trait: { type: "Outfit", value: "Kimono" } },
                ),
            ],
        });
        sdk.api.getTraits = async () => ({
            counts: {
                Outfit: { Kimono: 10 },
                Background: { Blue: 7, Green: 6 },
            },
        });
        sdk.api.getTraitOffers = async (_slug, type, value) => {
            traitRequests.push(`${type}:${value}`);
            if (type === "Outfit" && value === "Kimono") {
                return {
                    offers: [
                        makeOffer(
                            "0xtargettrait",
                            "0xother3",
                            "300000000000000000",
                            collectionAddress,
                            { trait: { type: "Outfit", value: "Kimono" } },
                        ),
                    ],
                };
            }
            if (type === "Background" && value === "Blue") {
                return {
                    offers: [
                        makeOffer(
                            "0xcompetitor-blue",
                            "0xother4",
                            "400000000000000000",
                            collectionAddress,
                            { trait: { type: "Background", value: "Blue" } },
                        ),
                    ],
                };
            }
            if (type === "Background" && value === "Green") {
                return {
                    offers: [
                        makeOffer(
                            "0xcompetitor-green",
                            makerAddress,
                            "500000000000000000",
                            collectionAddress,
                            { trait: { type: "Background", value: "Green" } },
                        ),
                    ],
                };
            }
            return { offers: [] };
        };

        const offers = await service.getActiveOffers(job);
        const ids = offers.map((offer) => offer.id);

        assert.ok(ids.includes("0xcollectionwide"));
        assert.ok(ids.includes("0xtargettrait"));
        assert.ok(ids.includes("0xcompetitor-blue"));
        assert.ok(ids.includes("0xcompetitor-green"));
        assert.ok(!ids.includes("0xignored-in-collection-page"));
        assert.ok(traitRequests.includes("Outfit:Kimono"));
        assert.ok(traitRequests.includes("Background:Blue"));
        assert.ok(traitRequests.includes("Background:Green"));
    });

    it("fails closed when competitive-trait expansion exceeds the lookup budget", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            competitiveTraitMaxLookupSelectors: 2,
        });
        const job = {
            id: "job-competitive-too-wide",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: { type: "Outfit", value: "Kimono" },
                competitorTraits: [{ type: "Background" }],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        let collectionOfferCalls = 0;
        let traitOfferCalls = 0;

        sdk.api.getCollectionOffers = async () => {
            collectionOfferCalls++;
            return { offers: [] };
        };
        sdk.api.getTraits = async () => ({
            counts: {
                Outfit: { Kimono: 10 },
                Background: { Blue: 7, Green: 6 },
            },
        });
        sdk.api.getTraitOffers = async () => {
            traitOfferCalls++;
            return { offers: [] };
        };

        await assert.rejects(
            () => service.getActiveOffers(job),
            /Competitive trait lookup selector count exceeds configured limit/,
        );
        assert.equal(collectionOfferCalls, 0);
        assert.equal(traitOfferCalls, 0);
    });

    it("uses cached snapshot discovery for multi-trait collection jobs and skips live collection fetches", async () => {
        const sdk = new MockOpenSeaSdk();
        let liveCollectionOfferCalls = 0;
        sdk.api.getCollectionOffers = async () => {
            liveCollectionOfferCalls++;
            return {
                offers: [
                    makeOffer(
                        "0xlive-collectionwide",
                        "0xother",
                        "100000000000000000",
                        collectionAddress,
                        { encoded_token_ids: "*" },
                    ),
                ],
            };
        };

        const snapshotProvider = new FakeCollectionOfferSnapshotProvider({
            [collectionSlug]: {
                collectionSlug,
                refreshedAt: Date.now(),
                offers: [
                    makeOffer(
                        "0xcollectionwide",
                        "0xother0",
                        "100000000000000000",
                        collectionAddress,
                        { encoded_token_ids: "*" },
                    ),
                    makeOffer(
                        "0xmulti-match",
                        "0xother1",
                        "200000000000000000",
                        collectionAddress,
                        {
                            traits: [
                                { type: "Mode", value: "Terrain" },
                                { type: "Biome", value: "81" },
                            ],
                        },
                    ),
                    makeOffer(
                        "0xsingle-only",
                        "0xother2",
                        "300000000000000000",
                        collectionAddress,
                        { trait: { type: "Biome", value: "81" } },
                    ),
                    makeOffer(
                        "0xmulti-miss",
                        "0xother3",
                        "400000000000000000",
                        collectionAddress,
                        {
                            traits: [
                                { type: "Biome", value: "81" },
                                { type: "Mode", value: "Water" },
                            ],
                        },
                    ),
                    makeOffer(
                        "0xexplicit-item",
                        "0xother4",
                        "500000000000000000",
                        collectionAddress,
                        undefined,
                        2,
                    ),
                ],
            },
        });
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            collectionOfferSnapshotProvider: snapshotProvider,
        });
        const job = {
            id: "job-multi-trait",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug,
            collectionAddress,
            target: {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
                traits: [
                    { type: "Biome", value: "81" },
                    { type: "Mode", value: "Terrain" },
                ],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        const offers = await service.getActiveOffers(job);
        const ids = offers.map((offer) => offer.id);

        assert.ok(ids.includes("0xcollectionwide"));
        assert.ok(ids.includes("0xmulti-match"));
        assert.ok(!ids.includes("0xsingle-only"));
        assert.ok(!ids.includes("0xmulti-miss"));
        assert.ok(!ids.includes("0xexplicit-item"));
        assert.equal(liveCollectionOfferCalls, 0);
    });

    it("uses cached token snapshot discovery for collection-wide and applicable criteria offers", async () => {
        const sdk = new MockOpenSeaSdk();
        let collectionOfferCalls = 0;
        sdk.api.getOffersByNFT = async () => ({ offers: [] });
        sdk.api.getCollectionOffers = async () => {
            collectionOfferCalls++;
            return { offers: [] };
        };
        sdk.api.getBestOffer = async () => null;

        const snapshotProvider = new FakeCollectionOfferSnapshotProvider({
            terraforms: {
                collectionSlug: "terraforms",
                refreshedAt: Date.now(),
                offers: [
                    makeOffer(
                        "0xcollection-wide",
                        "0xother0",
                        "50000000000000000",
                        collectionAddress,
                        { encoded_token_ids: "*" },
                    ),
                    makeOffer(
                        "0xsingle-trait",
                        "0xother1",
                        "100000000000000000",
                        collectionAddress,
                        {
                            encoded_token_ids: "100,123,456",
                            traits: [{ type: "Zone", value: "8" }],
                        },
                    ),
                    makeOffer(
                        "0xmulti-trait",
                        "0xother2",
                        "200000000000000000",
                        collectionAddress,
                        {
                            encoded_token_ids: "120:125,200",
                            traits: [
                                { type: "Zone", value: "8" },
                                { type: "Biome", value: "53" },
                            ],
                        },
                    ),
                    makeOffer(
                        "0xother-token-item",
                        makerAddress,
                        "800000000000000000",
                        collectionAddress,
                        undefined,
                        2,
                    ),
                    makeOffer(
                        "0xnon-match",
                        "0xother3",
                        "300000000000000000",
                        collectionAddress,
                        {
                            encoded_token_ids: "999,1000",
                            traits: [{ type: "Biome", value: "9" }],
                        },
                    ),
                    makeOffer(
                        "0xencoded-miss-traits-match",
                        "0xother5",
                        "350000000000000000",
                        collectionAddress,
                        {
                            encoded_token_ids: "999,1000",
                            traits: [{ type: "Zone", value: "8" }],
                        },
                    ),
                    makeOffer(
                        "0xunsupported-trait",
                        "0xother4",
                        "400000000000000000",
                        collectionAddress,
                        {
                            encoded_token_ids: "123,500",
                            traits: [{ type: "Chroma", value: "Flow" }],
                        },
                    ),
                ],
            },
        });
        const tokenMetadataRepository = new FakeTokenMetadataRepository({
            "terraforms:123": [
                { type: "Zone", value: "8" },
                { type: "Biome", value: "53" },
                { type: "Chroma", value: "Flow" },
            ],
        });
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            collectionOfferSnapshotProvider: snapshotProvider,
            tokenMetadataRepository,
        });
        const job = {
            id: "token-job",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug: "terraforms",
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        const offers = await service.getActiveOffers(job);
        const ids = offers.map((offer) => offer.id);

        assert.ok(ids.includes("0xcollection-wide"));
        assert.ok(ids.includes("0xsingle-trait"));
        assert.ok(ids.includes("0xmulti-trait"));
        assert.ok(!ids.includes("0xother-token-item"));
        assert.ok(!ids.includes("0xnon-match"));
        assert.ok(!ids.includes("0xencoded-miss-traits-match"));
        assert.ok(ids.includes("0xunsupported-trait"));
        assert.equal(collectionOfferCalls, 0);
    });

    it("matches wildcard and criteria-only token snapshot offers against token metadata by default", async () => {
        const sdk = new MockOpenSeaSdk();
        sdk.api.getOffersByNFT = async () => ({ offers: [] });
        sdk.api.getCollectionOffers = async () => ({ offers: [] });
        sdk.api.getBestOffer = async () => null;

        const snapshotProvider = new FakeCollectionOfferSnapshotProvider({
            terraforms: {
                collectionSlug: "terraforms",
                refreshedAt: Date.now(),
                offers: [
                    makeOffer(
                        "0xwildcard-zone",
                        "0xother1",
                        "100000000000000000",
                        collectionAddress,
                        {
                            encoded_token_ids: "*",
                            traits: [{ type: "Zone", value: "8" }],
                        },
                    ),
                    makeOffer(
                        "0xcriteria-only-biome",
                        "0xother2",
                        "200000000000000000",
                        collectionAddress,
                        {
                            traits: [{ type: "Biome", value: "53" }],
                        },
                    ),
                    makeOffer(
                        "0xcriteria-only-miss",
                        "0xother3",
                        "300000000000000000",
                        collectionAddress,
                        {
                            traits: [{ type: "Mode", value: "Day" }],
                        },
                    ),
                ],
            },
        });
        const tokenMetadataRepository = new FakeTokenMetadataRepository({
            "terraforms:123": [
                { type: "Zone", value: "8" },
                { type: "Biome", value: "53" },
            ],
        });
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            collectionOfferSnapshotProvider: snapshotProvider,
            tokenMetadataRepository,
        });
        const job = {
            id: "token-job",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug: "terraforms",
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        const offers = await service.getActiveOffers(job);
        const ids = offers.map((offer) => offer.id);

        assert.ok(ids.includes("0xwildcard-zone"));
        assert.ok(ids.includes("0xcriteria-only-biome"));
        assert.ok(!ids.includes("0xcriteria-only-miss"));
    });

    it("uses configured token criteria traits as an optional matching restriction", async () => {
        const sdk = new MockOpenSeaSdk();
        sdk.api.getOffersByNFT = async () => ({ offers: [] });
        sdk.api.getCollectionOffers = async () => ({ offers: [] });
        sdk.api.getBestOffer = async () => null;

        const snapshotProvider = new FakeCollectionOfferSnapshotProvider({
            terraforms: {
                collectionSlug: "terraforms",
                refreshedAt: Date.now(),
                offers: [
                    makeOffer(
                        "0xconfigured-zone",
                        "0xother1",
                        "100000000000000000",
                        collectionAddress,
                        {
                            traits: [{ type: "Zone", value: "8" }],
                        },
                    ),
                    makeOffer(
                        "0xrestricted-biome",
                        "0xother2",
                        "200000000000000000",
                        collectionAddress,
                        {
                            traits: [{ type: "Biome", value: "53" }],
                        },
                    ),
                ],
            },
        });
        const tokenMetadataRepository = new FakeTokenMetadataRepository({
            "terraforms:123": [
                { type: "Zone", value: "8" },
                { type: "Biome", value: "53" },
            ],
        });
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            collectionOfferSnapshotProvider: snapshotProvider,
            tokenMetadataRepository,
            tokenCriteriaTraitsByCollection: {
                terraforms: ["Zone"],
            },
        });
        const job = {
            id: "token-job",
            revision: 1,
            network: "eth" as const,
            collectionId: 1,
            collectionSlug: "terraforms",
            collectionAddress,
            target: { type: BIDDER_TARGET_TYPE.Token, tokenId: "123" },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };

        const offers = await service.getActiveOffers(job);
        const ids = offers.map((offer) => offer.id);

        assert.ok(ids.includes("0xconfigured-zone"));
        assert.ok(!ids.includes("0xrestricted-biome"));
    });
});
