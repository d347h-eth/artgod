import type {
    ChainRecord,
    CollectionListItem,
} from "@artgod/shared/types/browse";
import {
    PRICE_HISTORY_BUCKET,
    PRICE_HISTORY_RANGE,
    PRICE_HISTORY_RANGE_DAYS,
    PRICE_HISTORY_LIMITS,
    type PriceHistory,
    type PriceHistoryRequest,
} from "@artgod/shared/types/price-history";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    buildRealizedPriceHistory,
    type PricedFill,
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
    // The iterator bounds allocations and includes one extra row to detect overflow.
    iterateSingleTokenSales(input: {
        chainId: number;
        collectionId: number;
        tokenId?: string;
        from: number;
        to: number;
        limit: number;
    }): Iterable<PricedFill>;
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
        const bucket = input.bucket ?? PRICE_HISTORY_BUCKET.Day;
        const range = input.range ?? PRICE_HISTORY_RANGE.All;
        if (
            !Object.values(PRICE_HISTORY_BUCKET).includes(
                bucket as PriceHistoryRequest["bucket"],
            ) ||
            !Object.values(PRICE_HISTORY_RANGE).includes(
                range as PriceHistoryRequest["range"],
            )
        ) {
            throw new ReadModelBadRequestError(
                "Invalid price history range or bucket.",
            );
        }
        if (
            input.tokenId !== undefined &&
            (!/^\d{1,78}$/.test(input.tokenId) ||
                BigInt(input.tokenId) >= 2n ** 256n)
        ) {
            throw new ReadModelBadRequestError("Invalid token ID.");
        }
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
        const request = {
            bucket,
            range,
            tokenId:
                input.tokenId === undefined
                    ? undefined
                    : BigInt(input.tokenId).toString(),
        } as PriceHistoryRequest;
        const to = this.now() + 1;
        const days = PRICE_HISTORY_RANGE_DAYS[request.range];
        const fills: PricedFill[] = [];
        for (const fill of this.prices.iterateSingleTokenSales({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: request.tokenId,
            from: days === null ? 0 : to - days * 86400,
            to,
            limit: PRICE_HISTORY_LIMITS.fills + 1,
        })) {
            if (fills.length === PRICE_HISTORY_LIMITS.fills) {
                throw new ReadModelBadRequestError(
                    "Choose a shorter price history range.",
                );
            }
            fills.push(fill);
        }
        return buildRealizedPriceHistory(fills, request, to);
    }
}
