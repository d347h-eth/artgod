import type {
    ChainRecord,
    CollectionListItem,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import {
    PRICE_HISTORY_RANGE_DAYS,
    PRICE_HISTORY_LIMITS,
    type PriceHistory,
    type PriceHistoryObservation,
} from "@artgod/shared/types/price-history";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    buildRealizedPriceHistory,
    resolvePriceHistoryRequest,
    PriceHistoryInputError,
} from "../../../domain/realized-price-history.js";

export type GetPriceHistoryInput = {
    chainRef: string;
    collectionRef: string;
    tokenId?: string;
    bucket?: string;
    range?: string;
    traits?: TraitFilter[];
    traitRanges?: TraitRangeFilter[];
};
export type GetPriceHistoryPort = {
    getPriceHistory(input: GetPriceHistoryInput): PriceHistory;
};
export type PriceHistoryReadPort = {
    // Prepared attributed NFT items, including classified omissions. Allocation
    // uses the complete execution before request filters; currency is retained.
    // Ascending timestamp, block, log and row identity. The domain consumes once;
    // Trait predicates use current token attributes and apply before the limit.
    // The adapter must include one extra row so limits never silently truncate.
    iterateObservations(input: {
        chainId: number;
        collectionId: number;
        tokenId?: string;
        traits?: TraitFilter[];
        traitRanges?: TraitRangeFilter[];
        from: number;
        to: number;
        limit: number;
    }): Iterable<PriceHistoryObservation>;
};

export class GetPriceHistoryUseCase implements GetPriceHistoryPort {
    constructor(
        private readonly defaultChainId: number,
        private readonly chains: {
            resolveChainRef(ref: string, defaultChainId: number): ChainRecord;
        },
        private readonly collections: {
            resolveCollectionRef(
                chainId: number,
                ref: string,
            ): CollectionListItem;
        },
        private readonly prices: PriceHistoryReadPort,
        private readonly now: () => number = () =>
            Math.floor(Date.now() / 1000),
    ) {}

    getPriceHistory(input: GetPriceHistoryInput): PriceHistory {
        try {
            return this.readHistory(input);
        } catch (error) {
            if (error instanceof PriceHistoryInputError)
                throw new ReadModelBadRequestError(error.message);
            throw error;
        }
    }

    private readHistory(input: GetPriceHistoryInput): PriceHistory {
        const request = resolvePriceHistoryRequest(input);
        const chain = this.chains.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // WETH configuration is runtime-chain scoped, not a cross-chain currency registry.
        if (chain.publicChainId !== this.defaultChainId) {
            throw new ReadModelBadRequestError(
                "Price history is not configured for this chain.",
            );
        }
        const collection = this.collections.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const to = this.now() + 1;
        const days = PRICE_HISTORY_RANGE_DAYS[request.range];
        const fills = this.prices.iterateObservations({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: request.tokenId,
            traits: input.traits,
            traitRanges: input.traitRanges,
            from: days === null ? 0 : to - days * 86400,
            to,
            limit: PRICE_HISTORY_LIMITS.fills + 1,
        });
        return buildRealizedPriceHistory(fills, request, to);
    }
}
