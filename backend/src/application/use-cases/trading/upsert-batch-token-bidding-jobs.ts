import { DEFAULT_PAGE_LIMIT } from "@artgod/shared/config/pagination";
import type {
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TokenBrowserStatus,
    TokenCursorPage,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types";
import type {
    BiddingJobsRepositoryPort,
    UpsertTokenBiddingJobInput as PersistedUpsertTokenBiddingJobInput,
} from "./ports.js";
import {
    resolveBiddingJobPricing,
    type BiddingJobPriceTierReadPort,
} from "./bidding-job-pricing.js";
import type {
    BatchTokenBiddingJobSelection,
    UpsertBatchTokenBiddingJobsOutput,
} from "./types.js";
import {
    mapPersistedTokenBiddingJobToView,
    TradingValidationError,
    type TokenBiddingJobMutationStatus,
} from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    type BiddingBidBookRepositoryPort,
} from "./bidding-bid-book.js";
import {
    buildTokenOfferGroups,
    sortTokenIdsByTopOffer,
    tokenMatchesTraitFilters,
} from "./bidding-token-offer-cards.js";
export type { UpsertBatchTokenBiddingJobsOutput } from "./types.js";

export type UpsertBatchTokenBiddingJobsInput = {
    chainRef: string;
    collectionRef: string;
    status: TokenBiddingJobMutationStatus;
    floorEth?: string;
    ceilingEth?: string;
    deltaEth: string;
    priceTierId?: string | null;
    selection: BatchTokenBiddingJobSelection;
};

export class UpsertBatchTokenBiddingJobsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            listCollectionTokens(params: {
                chainId: number;
                collectionId: number;
                tokenStatus: TokenBrowserStatus;
                limit: number;
                cursor?: string;
                traitFilters?: TraitFilter[];
                traitRangeFilters?: TraitRangeFilter[];
            }): TokenCursorPage;
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
            }): TokenCard[];
        },
        readonly bidBookRepositoryPort: Pick<
            BiddingBidBookRepositoryPort,
            "listCollectionBidBook"
        >,
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "upsertTokenJobs"
        >,
        readonly biddingPriceTiersRepositoryPort: BiddingJobPriceTierReadPort,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    upsertBatchTokenBiddingJobs(
        input: UpsertBatchTokenBiddingJobsInput,
    ): UpsertBatchTokenBiddingJobsOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before resolving its token selection.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );

        // Resolve manual or tier-backed pricing into bot-facing scalar wei values.
        const pricing = resolveBiddingJobPricing({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            input,
            priceTierReadPort: this.biddingPriceTiersRepositoryPort,
        });

        const tokenIds = this.resolveTokenIds({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            selection: input.selection,
        });
        if (tokenIds.length === 0) {
            throw new TradingValidationError("token selection is empty");
        }

        const persistedInputs: PersistedUpsertTokenBiddingJobInput[] = tokenIds.map(
            (tokenId) => ({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenId,
                status: input.status,
                floorWei: pricing.floorWei,
                ceilingWei: pricing.ceilingWei,
                deltaWei: pricing.deltaWei,
                priceTierId: pricing.priceTierId,
                pricingSource: pricing.pricingSource,
            }),
        );
        // Persist the batch as one SQLite transaction and enqueue one command per affected job.
        const result = this.biddingJobsRepositoryPort.upsertTokenJobs(
            persistedInputs,
        );
        // Publish a post-commit wake-up so the running bot scans all durable command rows immediately.
        this.tradingJobCommandSignalPort.publishBiddingJobCommandsChanged(
            result.commands,
        );

        return {
            chain,
            collection,
            tokenIds,
            jobs: result.jobs.map((job) => mapPersistedTokenBiddingJobToView(job)),
        };
    }

    private resolveTokenIds(params: {
        chainId: number;
        collectionId: number;
        selection: BatchTokenBiddingJobSelection;
    }): string[] {
        if (params.selection.type === "token_ids") {
            return this.resolveExplicitTokenIds({
                chainId: params.chainId,
                collectionId: params.collectionId,
                selection: params.selection,
            });
        }
        if (params.selection.type === "token_offer_filter") {
            return this.resolveTokenOfferFilterTokenIds({
                chainId: params.chainId,
                collectionId: params.collectionId,
                selection: params.selection,
            });
        }
        return this.resolveFilteredTokenIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            selection: params.selection,
        });
    }

    private resolveExplicitTokenIds(params: {
        chainId: number;
        collectionId: number;
        selection: Extract<BatchTokenBiddingJobSelection, { type: "token_ids" }>;
    }): string[] {
        const tokenIds = uniqueNonEmptyTokenIds(params.selection.tokenIds);
        if (tokenIds.length === 0) {
            return [];
        }
        // Verify explicit token IDs belong to this collection before mutating jobs.
        const cards = this.collectionReadPort.listCollectionTokenCardsByIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenIds,
        });
        const found = new Set(cards.map((card) => card.tokenId));
        const missing = tokenIds.filter((tokenId) => !found.has(tokenId));
        if (missing.length > 0) {
            throw new TradingValidationError(
                `unknown token id ${missing[0]}`,
            );
        }
        return tokenIds;
    }

    private resolveFilteredTokenIds(params: {
        chainId: number;
        collectionId: number;
        selection: Extract<BatchTokenBiddingJobSelection, { type: "filter" }>;
    }): string[] {
        const tokenIds: string[] = [];
        let cursor: string | undefined;
        do {
            // Read one token-browser page at a time so large filtered selections do not preallocate.
            const page = this.collectionReadPort.listCollectionTokens({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenStatus: params.selection.tokenStatus,
                limit: DEFAULT_PAGE_LIMIT,
                cursor,
                traitFilters: params.selection.traits,
                traitRangeFilters: params.selection.traitRanges,
            });
            for (const token of page.items) {
                tokenIds.push(token.tokenId);
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return uniqueNonEmptyTokenIds(tokenIds);
    }

    private resolveTokenOfferFilterTokenIds(params: {
        chainId: number;
        collectionId: number;
        selection: Extract<
            BatchTokenBiddingJobSelection,
            { type: "token_offer_filter" }
        >;
    }): string[] {
        // Read token-scoped bids from the same source-selection path used by the offers page.
        const tokenBidBook = this.bidBookRepositoryPort.listCollectionBidBook({
            chainId: params.chainId,
            collectionId: params.collectionId,
            scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
            traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
            selectedTraits: [],
            selectedTraitRanges: [],
            makerAddress: params.selection.makerAddress ?? null,
        });
        // Read collection bids so low-signal token offers are filtered exactly like the token-offer cards.
        const collectionBidBook =
            this.bidBookRepositoryPort.listCollectionBidBook({
                chainId: params.chainId,
                collectionId: params.collectionId,
                scopeFilter: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
                traitFilterJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
                selectedTraits: [],
                selectedTraitRanges: [],
                makerAddress: null,
            });
        const offersByTokenId = buildTokenOfferGroups({
            tokenBids: tokenBidBook.bids,
            collectionBids: collectionBidBook.bids,
        });
        const tokenIds = sortTokenIdsByTopOffer(offersByTokenId);
        if (tokenIds.length === 0) {
            return [];
        }
        // Hydrate matched token IDs so trait filters apply to token metadata, not bid payloads.
        const cards = this.collectionReadPort.listCollectionTokenCardsByIds({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenIds,
        });
        const cardsById = new Map(cards.map((card) => [card.tokenId, card]));
        return tokenIds.filter((tokenId) => {
            const card = cardsById.get(tokenId);
            return (
                card !== undefined &&
                tokenMatchesTraitFilters(
                    card,
                    params.selection.traits,
                    params.selection.traitRanges,
                )
            );
        });
    }
}

function uniqueNonEmptyTokenIds(values: string[]): string[] {
    const seen = new Set<string>();
    const tokenIds: string[] = [];
    for (const value of values) {
        const tokenId = value.trim();
        if (!tokenId || seen.has(tokenId)) {
            continue;
        }
        seen.add(tokenId);
        tokenIds.push(tokenId);
    }
    return tokenIds;
}
