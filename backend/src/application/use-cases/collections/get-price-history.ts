import type {
    ChainRecord,
    CollectionListItem,
} from "@artgod/shared/types/browse";
import {
    PRICE_HISTORY_RANGE_DAYS,
    PRICE_HISTORY_LIMITS,
    type PriceHistory,
    type RealizedSale,
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
};
export type GetPriceHistoryPort = {
    getPriceHistory(input: GetPriceHistoryInput): PriceHistory;
};
export type PriceHistoryReadPort = {
    // Only verified single-NFT ETH-equivalent fills, retaining execution currency.
    // Ascending timestamp, block, log and row identity. The domain consumes once;
    // the adapter must include one extra row so limits never silently truncate.
    iterateSingleTokenSales(input: {
        chainId: number;
        collectionId: number;
        tokenId?: string;
        from: number;
        to: number;
        limit: number;
    }): Iterable<RealizedSale>;
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
        const fills = this.prices.iterateSingleTokenSales({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: request.tokenId,
            from: days === null ? 0 : to - days * 86400,
            to,
            limit: PRICE_HISTORY_LIMITS.fills + 1,
        });
        return buildRealizedPriceHistory(fills, request, to);
    }
}
