import { TRADING_BIDDING_BID_BOOK_PRICE_KIND } from '@artgod/shared/types';
import type { ApiBiddingBidBookPrice, ApiBiddingBidBookRow } from '$lib/api-types';

// Resolves the comparable bid-book price for sorting and low-signal filtering.
export function bidBookPriceEffectiveWei(price: ApiBiddingBidBookPrice): string {
	if (price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact) {
		return price.wei;
	}
	return price.ceilingWei;
}

// Resolves the comparable bid-book price in Ether for display-only precision decisions.
export function bidBookPriceEffectiveEth(price: ApiBiddingBidBookPrice): string {
	if (price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact) {
		return price.eth;
	}
	return price.ceilingEth;
}

// Resolves the comparable bid-book price from a row without leaking row internals.
export function bidBookRowEffectivePriceWei(bid: Pick<ApiBiddingBidBookRow, 'price'>): bigint {
	return BigInt(bidBookPriceEffectiveWei(bid.price));
}
