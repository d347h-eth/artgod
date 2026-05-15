import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { TokenMetadataRepository } from "../../domain/market/token-metadata-repository.js";
import { CollectionOfferSnapshotProvider } from "../../application/use-cases/bidding/collection-offer-snapshot-service.js";
import { OpenSeaBiddingService } from "./open-sea-bidding-service.js";
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
    minDelayMs: 0,
    maxDelayMs: 0,
    factor: 1,
    jitterRatio: 0,
};

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

class FakeCollectionOfferSnapshotProvider
    implements CollectionOfferSnapshotProvider
{
    constructor(
        private readonly snapshots: Record<
            string,
            { collectionSlug: string; offers: unknown[]; refreshedAt: number }
        >,
    ) {}

    public getSnapshot(collectionSlug: string) {
        return this.snapshots[collectionSlug] ?? null;
    }
}

class FakeTokenMetadataRepository implements TokenMetadataRepository {
    constructor(private readonly rows: Record<string, string>) {}

    async getMetadata(
        collectionSlug: string,
        tokenId: string,
    ): Promise<string | null> {
        return this.rows[`${collectionSlug}:${tokenId}`] ?? null;
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

    it("places collection offers with expiration and quantity-aware totals", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_RETRY_POLICY,
        });
        const job = {
            id: "job-1",
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: {
                type: "collection" as const,
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

        const result = await service.placeOffer(job, 1_000000000000000000n);

        assert.equal(result.orderHash, orderHash);
        assert.equal(result.protocolAddress, protocolAddress);
        assert.ok(result.expirationTime !== undefined);
    });

    it("places competitive-trait and multi-trait collection offers without drifting trait payloads", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);

        const competitiveTraitJob = {
            id: "job-ct",
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: {
                type: "competitiveTrait" as const,
                quantity: 1,
                targetTrait: { type: "Outfit", value: "Kimono" },
                competitorTraits: [{ type: "Background" }],
            },
            config: { floor: 1n, ceiling: 2n, delta: 1n },
            state: {},
        };
        const multiTraitJob = {
            id: "job-mt",
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: {
                type: "collection" as const,
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
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: { type: "token" as const, tokenId: "123" },
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

        const result = await service.placeOffer(job, 1_000000000000000000n);

        assert.equal(result.orderHash, orderHash);
        assert.equal(result.protocolAddress, protocolAddress);
        assert.ok(result.expirationTime !== undefined);
    });

    it("cancels offers via offchainCancelOrder and requires protocol address", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const calls: unknown[][] = [];

        sdk.offchainCancelOrder = async (...args: unknown[]) => {
            calls.push(args);
        };

        await service.cancelOffer(
            {} as any,
            {
                id: orderHash,
                maker: makerAddress,
                price: 1n,
                protocolAddress,
            },
        );

        assert.deepEqual(calls, [[protocolAddress, orderHash, "ethereum", undefined, true]]);
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
        assert.ok(active);
        assert.equal(active?.id, orderHash);

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
        assert.equal(inactive, null);
    });

    it("falls back to paginated collection offer scans for order recovery", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            retryPolicy: TEST_RETRY_POLICY,
        });
        let pageCalls = 0;

        sdk.api.getOrderByHash = async () => {
            throw new Error("Not found");
        };
        sdk.api.getAllOffers = async (_slug, _limit, next) => {
            pageCalls++;
            if (!next) {
                return { offers: [{ order_hash: "0xother" }], next: "page-2" };
            }
            return {
                offers: [
                    {
                        order_hash: orderHash,
                        status: "active",
                        maker: { address: makerAddress },
                        protocol_data: {
                            parameters: {
                                offer: [
                                    { token: WETH, amount: "1000000000000000000" },
                                ],
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
                    },
                ],
            };
        };

        const recovered = await service.getOrder(
            orderHash,
            protocolAddress,
            collectionAddress,
            undefined,
            collectionSlug,
        );

        assert.ok(recovered);
        assert.equal(recovered?.id, orderHash);
        assert.equal(pageCalls, 2);
    });

    it("queries maker-specific token offers and returns the best parsed order", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const job = {
            id: "job-maker",
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: { type: "token" as const, tokenId: "123" },
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

    it("includes collection-wide and expanded competitive-trait buckets", async () => {
        const sdk = new MockOpenSeaSdk();
        const service = new OpenSeaBiddingService(sdk as any, makerAddress);
        const job = {
            id: "job-competitive",
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: {
                type: "competitiveTrait" as const,
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
            network: "eth" as const,
            collectionSlug,
            collectionAddress,
            target: {
                type: "collection" as const,
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
            "terraforms:123": JSON.stringify([
                { traitType: "Zone", value: "8" },
                { traitType: "Biome", value: "53" },
                { traitType: "Chroma", value: "Flow" },
            ]),
        });
        const service = new OpenSeaBiddingService(sdk as any, makerAddress, {
            collectionOfferSnapshotProvider: snapshotProvider,
            tokenMetadataRepository,
        });
        const job = {
            id: "token-job",
            network: "eth" as const,
            collectionSlug: "terraforms",
            collectionAddress,
            target: { type: "token" as const, tokenId: "123" },
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
        assert.ok(ids.includes("0xunsupported-trait"));
        assert.equal(collectionOfferCalls, 0);
    });
});
