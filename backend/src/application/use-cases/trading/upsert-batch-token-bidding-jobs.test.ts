import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type PersistedTokenBiddingJobRecord,
    type TokenCard,
    type TokenCursorPage,
    type TradingJobCommandRecord,
} from "@artgod/shared/types";
import { COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE } from "./bidding-bid-book.js";
import {
    exactBidBookRowPrice,
    marketBidMaterialization,
} from "./bidding-bid-book.js";
import { UpsertBatchTokenBiddingJobsUseCase } from "./upsert-batch-token-bidding-jobs.js";

const CHAIN: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

const COLLECTION: CollectionListItem = {
    chainId: 1,
    collectionId: 7,
    slug: "terraforms",
    address: "0x1111111111111111111111111111111111111111",
    standard: "erc721",
    status: "live",
    deploymentBlock: 1,
    bootstrapAnchorBlock: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

describe("UpsertBatchTokenBiddingJobsUseCase", () => {
    it("resolves a filtered selection across all token pages and publishes durable commands", () => {
        const commands = buildCommands(["1", "2", "3"]);
        const persistedInputs: {
            tokenId: string;
            floorWei: string;
            ceilingWei: string;
            deltaWei: string;
        }[] = [];
        let publishedCommands: TradingJobCommandRecord[] = [];
        const useCase = new UpsertBatchTokenBiddingJobsUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
                listCollectionTokens: ({ cursor }) =>
                    cursor === "page-2"
                        ? tokenPage(["3"], null)
                        : tokenPage(["1", "2"], "page-2"),
                listCollectionTokenCardsByIds: () => [],
            },
            emptyBidBookRepository(),
            {
                upsertTokenJobs: (inputs) => {
                    persistedInputs.push(...inputs);
                    return {
                        jobs: inputs.map((input) =>
                            buildPersistedTokenJob({
                                tokenId: input.tokenId,
                                floorWei: input.floorWei,
                                ceilingWei: input.ceilingWei,
                                deltaWei: input.deltaWei,
                            }),
                        ),
                        commands,
                    };
                },
            },
            {
                listCollectionPriceTiers: () => [],
            },
            {
                publishBiddingJobCommandsChanged: (nextCommands) => {
                    publishedCommands = nextCommands;
                },
            },
        );

        const result = useCase.upsertBatchTokenBiddingJobs({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            status: TRADING_JOB_STATUS.Enabled,
            floorEth: "0.1",
            ceilingEth: "0.2",
            deltaEth: "0.001",
            selection: {
                type: "filter",
                tokenStatus: "all",
                traits: [{ key: "Mode", value: "Terrain" }],
                traitRanges: [],
            },
        });

        assert.deepEqual(result.tokenIds, ["1", "2", "3"]);
        assert.deepEqual(
            persistedInputs.map((input) => input.tokenId),
            ["1", "2", "3"],
        );
        assert.equal(persistedInputs[0]?.floorWei, "100000000000000000");
        assert.equal(persistedInputs[0]?.ceilingWei, "200000000000000000");
        assert.equal(persistedInputs[0]?.deltaWei, "1000000000000000");
        assert.deepEqual(publishedCommands, commands);
    });

    it("rejects explicit token IDs that do not belong to the collection", () => {
        const useCase = new UpsertBatchTokenBiddingJobsUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
                listCollectionTokens: () => tokenPage([], null),
                listCollectionTokenCardsByIds: () => [tokenCard("1")],
            },
            emptyBidBookRepository(),
            {
                upsertTokenJobs: () => {
                    throw new Error("Unexpected token job mutation");
                },
            },
            {
                listCollectionPriceTiers: () => [],
            },
            {
                publishBiddingJobCommandsChanged: () => {
                    throw new Error("Unexpected command publish");
                },
            },
        );

        assert.throws(
            () =>
                useCase.upsertBatchTokenBiddingJobs({
                    chainRef: "ethereum",
                    collectionRef: "terraforms",
                    status: TRADING_JOB_STATUS.Enabled,
                    floorEth: "0.1",
                    ceilingEth: "0.2",
                    deltaEth: "0.001",
                    selection: {
                        type: "token_ids",
                        tokenIds: ["1", "404"],
                    },
                }),
            /unknown token id 404/,
        );
    });

    it("resolves a token-offer selection across all offer pages and keeps token trait filters server-side", () => {
        const commands = buildCommands(["7", "8"]);
        const persistedInputs: { tokenId: string }[] = [];
        const useCase = new UpsertBatchTokenBiddingJobsUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
                listCollectionTokens: () => tokenPage([], null),
                listCollectionTokenCardsByIds: ({ tokenIds }) =>
                    tokenIds.map((tokenId) =>
                        tokenCard(
                            tokenId,
                            tokenId === "8"
                                ? [{ key: "Chroma", value: "Plague" }]
                                : [{ key: "Mode", value: "Terrain" }],
                        ),
                    ),
            },
            {
                listCollectionBidBook: ({ scopeFilter }) =>
                    scopeFilter === "collection"
                        ? bidBook([
                              bidBookRow({
                                  orderId: "collection-top",
                                  scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
                                  tokenId: null,
                                  wei: "1000000000000000000",
                              }),
                          ])
                        : bidBook([
                              bidBookRow({
                                  orderId: "token-7",
                                  scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                  tokenId: "7",
                                  wei: "500000000000000000",
                              }),
                              bidBookRow({
                                  orderId: "token-8",
                                  scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                  tokenId: "8",
                                  wei: "400000000000000000",
                              }),
                              bidBookRow({
                                  orderId: "muted-token-9",
                                  scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                  tokenId: "9",
                                  wei: "90000000000000000",
                              }),
                          ]),
            },
            {
                upsertTokenJobs: (inputs) => {
                    persistedInputs.push(...inputs);
                    return {
                        jobs: inputs.map((input) =>
                            buildPersistedTokenJob({
                                tokenId: input.tokenId,
                                floorWei: input.floorWei,
                                ceilingWei: input.ceilingWei,
                                deltaWei: input.deltaWei,
                            }),
                        ),
                        commands,
                    };
                },
            },
            {
                listCollectionPriceTiers: () => [],
            },
            {
                publishBiddingJobCommandsChanged: () => undefined,
            },
        );

        const result = useCase.upsertBatchTokenBiddingJobs({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            status: TRADING_JOB_STATUS.Enabled,
            floorEth: "0.1",
            ceilingEth: "0.2",
            deltaEth: "0.001",
            selection: {
                type: "token_offer_filter",
                traits: [
                    { key: "Mode", value: "Terrain" },
                    { key: "Chroma", value: "Plague" },
                ],
                traitRanges: [],
                traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
            },
        });

        assert.deepEqual(result.tokenIds, ["7", "8"]);
        assert.deepEqual(
            persistedInputs.map((input) => input.tokenId),
            ["7", "8"],
        );
    });

    it("respects token-offer maker filters when resolving all matching token IDs", () => {
        const persistedInputs: { tokenId: string }[] = [];
        const useCase = new UpsertBatchTokenBiddingJobsUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
                listCollectionTokens: () => tokenPage([], null),
                listCollectionTokenCardsByIds: ({ tokenIds }) =>
                    tokenIds.map((tokenId) => tokenCard(tokenId)),
            },
            {
                listCollectionBidBook: ({ scopeFilter, makerAddress }) => {
                    const bids =
                        scopeFilter === "collection"
                            ? [
                                  bidBookRow({
                                      orderId: "collection-top",
                                      scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
                                      tokenId: null,
                                      wei: "1000000000000000000",
                                  }),
                              ]
                            : [
                                  bidBookRow({
                                      orderId: "token-7",
                                      scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                      tokenId: "7",
                                      wei: "500000000000000000",
                                      maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                  }),
                                  bidBookRow({
                                      orderId: "token-8",
                                      scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                      tokenId: "8",
                                      wei: "400000000000000000",
                                      maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                  }),
                              ];
                    return bidBook(
                        makerAddress
                            ? bids.filter(
                                  (bid) =>
                                      bid.maker.toLowerCase() === makerAddress,
                              )
                            : bids,
                    );
                },
            },
            {
                upsertTokenJobs: (inputs) => {
                    persistedInputs.push(...inputs);
                    return {
                        jobs: inputs.map((input) =>
                            buildPersistedTokenJob({ tokenId: input.tokenId }),
                        ),
                        commands: [],
                    };
                },
            },
            {
                listCollectionPriceTiers: () => [],
            },
            {
                publishBiddingJobCommandsChanged: () => undefined,
            },
        );

        const result = useCase.upsertBatchTokenBiddingJobs({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            status: TRADING_JOB_STATUS.Enabled,
            floorEth: "0.1",
            ceilingEth: "0.2",
            deltaEth: "0.001",
            selection: {
                type: "token_offer_filter",
                traits: [],
                traitRanges: [],
                traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
                makerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
        });

        assert.deepEqual(result.tokenIds, ["7"]);
        assert.deepEqual(
            persistedInputs.map((input) => input.tokenId),
            ["7"],
        );
    });
});

function tokenPage(tokenIds: string[], nextCursor: string | null): TokenCursorPage {
    return {
        items: tokenIds.map((tokenId) => tokenCard(tokenId)),
        prevCursor: null,
        nextCursor,
        limit: 2,
        totalItems: tokenIds.length,
        rangeStart: tokenIds.length > 0 ? 1 : 0,
        rangeEnd: tokenIds.length,
        currentPage: 1,
        totalPages: nextCursor ? 2 : 1,
    };
}

function tokenCard(tokenId: string, attributes: TokenCard["attributes"] = []): TokenCard {
    return {
        tokenId,
        name: `Token #${tokenId}`,
        image: null,
        traitSummary: null,
        listingPrice: null,
        listingCurrency: null,
        attributes,
        hasMetadata: true,
        metadataUpdatedAt: "2026-01-01T00:00:00Z",
    };
}

function emptyBidBookRepository() {
    return {
        listCollectionBidBook: () => bidBook([]),
    };
}

function bidBook(bids: ReturnType<typeof bidBookRow>[]) {
    return {
        state: {
            source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
            updatedAt: "2026-01-01T00:00:00Z",
            snapshotRefreshedAtMs: null,
            projectedAt: null,
            rowCount: bids.length,
            durationMs: null,
            lastError: null,
        },
        ownMakerAddress: null,
        bids,
    };
}

function bidBookRow(input: {
    orderId: string;
    scopeKind: typeof TRADING_BIDDING_BID_SCOPE_KIND.Collection | typeof TRADING_BIDDING_BID_SCOPE_KIND.Token;
    tokenId: string | null;
    wei: string;
    maker?: string;
}) {
    return {
        orderId: input.orderId,
        source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        materialization: marketBidMaterialization(),
        scopeKind: input.scopeKind,
        scopeLabel: input.scopeKind,
        tokenId: input.tokenId,
        scopeTraits: [],
        encodedTokenIds: null,
        maker: input.maker ?? "0x1111111111111111111111111111111111111111",
        isOwn: false,
        price: exactBidBookRowPrice(input.wei),
        quantity: "1",
        currencyAddress: null,
        currencySymbol: "WETH",
        protocolAddress: null,
        validUntil: null,
        placedAt: null,
        snapshotRefreshedAtMs: null,
        seenAt: null,
        ownStatus: null,
    };
}

function buildCommands(tokenIds: string[]): TradingJobCommandRecord[] {
    return tokenIds.map((tokenId, index) => ({
        commandId: index + 1,
        jobId: `job-${tokenId}`,
        botKind: TRADING_BOT_KIND.Bidding,
        commandKind: TRADING_JOB_COMMAND_KIND.JobCreated,
        status: "pending",
        requestedRevision: 1,
        payload: {},
        attempts: 0,
        lastError: null,
        createdAt: "2026-01-01T00:00:00Z",
        claimedAt: null,
        completedAt: null,
    }));
}

function buildPersistedTokenJob(input: {
    tokenId: string;
    floorWei?: string;
    ceilingWei?: string;
    deltaWei?: string;
}): PersistedTokenBiddingJobRecord {
    return {
        jobId: `job-${input.tokenId}`,
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        collectionSlug: COLLECTION.slug,
        collectionOpenseaSlug: COLLECTION.slug,
        collectionAddress: COLLECTION.address,
        status: TRADING_JOB_STATUS.Enabled,
        floorWei: input.floorWei ?? "100000000000000000",
        ceilingWei: input.ceilingWei ?? "200000000000000000",
        deltaWei: input.deltaWei ?? "1000000000000000",
        priceTierId: null,
        pricingSource: null,
        revision: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
        runtime: null,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId: input.tokenId,
        quantity: null,
        targetTraits: [],
        competitorTraits: [],
    };
}
