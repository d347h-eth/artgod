import type { PersistedBiddingBidBookRow } from "./bidding-bid-book.js";
import { persistedBidBookRowEffectiveWei } from "./bidding-bid-book.js";

// Minimum visible opponent bid as a fraction of the top collection-wide bid.
export const BIDDING_BID_BOOK_LOW_SIGNAL_COLLECTION_BID_FLOOR_DENOMINATOR = 10n;

// Applies the shared low-signal bid-book floor while preserving own rows for operator awareness.
export function bidBookRowPassesCollectionBidFloor(params: {
    bid: PersistedBiddingBidBookRow;
    topCollectionBidWei: bigint | null;
}): boolean {
    if (params.bid.isOwn) {
        return true;
    }
    if (
        params.topCollectionBidWei === null ||
        params.topCollectionBidWei <= 0n
    ) {
        return true;
    }
    return (
        BigInt(persistedBidBookRowEffectiveWei(params.bid)) *
            BIDDING_BID_BOOK_LOW_SIGNAL_COLLECTION_BID_FLOOR_DENOMINATOR >=
        params.topCollectionBidWei
    );
}

// Filters bid-book rows using the same collection-wide floor used by token offer cards.
export function filterBidBookRowsByCollectionBidFloor(params: {
    bids: PersistedBiddingBidBookRow[];
    collectionBids: PersistedBiddingBidBookRow[];
}): PersistedBiddingBidBookRow[] {
    const topCollectionBidWei = topBidBookRowPriceWei(params.collectionBids);
    return params.bids.filter((bid) =>
        bidBookRowPassesCollectionBidFloor({ bid, topCollectionBidWei }),
    );
}

// Resolves the highest comparable row price for collection-wide floor filtering.
export function topBidBookRowPriceWei(
    bids: PersistedBiddingBidBookRow[],
): bigint | null {
    let top: bigint | null = null;
    for (const bid of bids) {
        const price = BigInt(persistedBidBookRowEffectiveWei(bid));
        if (top === null || price > top) {
            top = price;
        }
    }
    return top;
}
