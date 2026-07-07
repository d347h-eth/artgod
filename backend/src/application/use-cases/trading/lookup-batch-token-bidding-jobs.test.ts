import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type PersistedTokenBiddingJobRecord,
    type TokenCard,
    type TokenCursorPage,
} from "@artgod/shared/types";
import {
    exactBidBookRowPrice,
    marketBidMaterialization,
} from "./bidding-bid-book.js";
import { LookupBatchTokenBiddingJobsUseCase } from "./lookup-batch-token-bidding-jobs.js";

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

describe("LookupBatchTokenBiddingJobsUseCase", () => {
    it("resolves filtered token-offer targets and returns existing jobs without mutating", () => {
        const lookedUpTokenIds: string[] = [];
        const useCase = new LookupBatchTokenBiddingJobsUseCase(
            1,
            {
                resolveChainRef: () => CHAIN,
            },
            {
                resolveCollectionRef: () => COLLECTION,
                listCollectionTokens: () => tokenPage([], null),
                listCollectionTokenCardsByIds: ({ tokenIds }) =>
                    tokenIds.map((tokenId) =>
                        tokenCard(tokenId, [], tokenId !== "unminted-tile-921"),
                    ),
            },
            {
                listCollectionBidBook: ({ scopeFilter }) =>
                    scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                        ? bidBook([
                              bidBookRow({
                                  orderId: "order-token-1",
                                  scopeKind:
                                      TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                  tokenId: "1",
                                  wei: "200000000000000000",
                              }),
                              bidBookRow({
                                  orderId: "order-token-2",
                                  scopeKind:
                                      TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                  tokenId: "unminted-tile-921",
                                  wei: "300000000000000000",
                              }),
                              bidBookRow({
                                  orderId: "order-token-3",
                                  scopeKind:
                                      TRADING_BIDDING_BID_SCOPE_KIND.Token,
                                  tokenId: "3",
                                  wei: "100000000000000000",
                              }),
                          ])
                        : bidBook([]),
            },
            {
                getTokenJob: ({ tokenId }) => {
                    lookedUpTokenIds.push(tokenId);
                    return tokenId === "1"
                        ? buildPersistedTokenJob(tokenId)
                        : null;
                },
            },
        );

        const result = useCase.lookupBatchTokenBiddingJobs({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            includeOwnJobContext: false,
            selection: {
                type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter,
                traits: [],
                traitRanges: [],
                traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
                makerAddress: null,
            },
        });

        assert.deepEqual(result.tokenIds, ["1", "3"]);
        assert.deepEqual(lookedUpTokenIds, ["1", "3"]);
        assert.equal(result.targetCount, 2);
        assert.deepEqual(
            result.jobs.map((job) => job.jobId),
            ["job-1"],
        );
    });

    it("resolves token-offer targets with the same own context as private bid-book views", () => {
        const bidBookOwnContextFlags: boolean[] = [];
        const useCase = new LookupBatchTokenBiddingJobsUseCase(
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
                listCollectionBidBook: ({
                    scopeFilter,
                    includeOwnJobContext,
                }) => {
                    bidBookOwnContextFlags.push(includeOwnJobContext);
                    if (
                        !includeOwnJobContext ||
                        scopeFilter !==
                            COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
                    ) {
                        return bidBook([]);
                    }
                    return bidBook([
                        bidBookRow({
                            orderId: "own-token-7",
                            scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                            tokenId: "7",
                            wei: "300000000000000000",
                        }),
                    ]);
                },
            },
            {
                getTokenJob: ({ tokenId }) =>
                    tokenId === "7" ? buildPersistedTokenJob(tokenId) : null,
            },
        );

        const result = useCase.lookupBatchTokenBiddingJobs({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            includeOwnJobContext: true,
            selection: {
                type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter,
                traits: [],
                traitRanges: [],
                traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
                makerAddress: "0x1111111111111111111111111111111111111111",
            },
        });

        assert.deepEqual(bidBookOwnContextFlags, [true, true]);
        assert.deepEqual(result.tokenIds, ["7"]);
        assert.equal(result.targetCount, 1);
        assert.deepEqual(
            result.jobs.map((job) => job.jobId),
            ["job-7"],
        );
    });
});

function tokenPage(
    tokenIds: string[],
    nextCursor: string | null,
): TokenCursorPage {
    return {
        items: tokenIds.map((tokenId) => tokenCard(tokenId)),
        prevCursor: null,
        nextCursor,
        limit: 2,
        totalItems: tokenIds.length,
        marketplaceBiddingSupportedTotalItems: tokenIds.length,
        rangeStart: tokenIds.length > 0 ? 1 : 0,
        rangeEnd: tokenIds.length,
        currentPage: 1,
        totalPages: nextCursor ? 2 : 1,
    };
}

function tokenCard(
    tokenId: string,
    attributes: TokenCard["attributes"] = [],
    marketplaceBiddingSupported = true,
): TokenCard {
    return {
        tokenId,
        marketplaceBiddingSupported,
        name: `Token #${tokenId}`,
        image: null,
        animationUrl: null,
        traitSummary: null,
        listingPrice: null,
        listingCurrency: null,
        attributes,
        hasMetadata: true,
        metadataUpdatedAt: "2026-01-01T00:00:00Z",
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
    scopeKind:
        | typeof TRADING_BIDDING_BID_SCOPE_KIND.Collection
        | typeof TRADING_BIDDING_BID_SCOPE_KIND.Token;
    tokenId: string | null;
    wei: string;
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
        maker: "0x1111111111111111111111111111111111111111",
        isOwn: false,
        price: exactBidBookRowPrice(input.wei),
        bidLimits: null,
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

function buildPersistedTokenJob(
    tokenId: string,
): PersistedTokenBiddingJobRecord {
    return {
        jobId: `job-${tokenId}`,
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId: COLLECTION.collectionId,
        collectionSlug: COLLECTION.slug,
        collectionOpenseaSlug: COLLECTION.slug,
        collectionAddress: COLLECTION.address,
        status: TRADING_JOB_STATUS.Enabled,
        floorWei: "100000000000000000",
        ceilingWei: "200000000000000000",
        deltaWei: "1000000000000000",
        priceTierId: null,
        pricingSource: null,
        revision: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
        runtime: null,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId,
        quantity: null,
        targetTraits: [],
        competitorTraits: [],
    };
}
