import type { ApiBiddingBidBookRow } from '$lib/api-types';

const BID_BOOK_TRAIT_DISPLAY_MAX_LENGTH = 96;

export type BidBookTraitFilterValue = {
	key: string;
	value: string;
};

export type BidBookTraitValueHref = (trait: BidBookTraitFilterValue) => string;

// Keeps untrusted marketplace trait text from dominating compact bid-book rows.
export function trimBidBookTraitText(value: string): string {
	const trimmed = value.trim();
	return trimmed.length <= BID_BOOK_TRAIT_DISPLAY_MAX_LENGTH
		? trimmed
		: `${trimmed.slice(0, BID_BOOK_TRAIT_DISPLAY_MAX_LENGTH - 3)}...`;
}

export type BidBookScopeTraits = ApiBiddingBidBookRow['scope']['traits'];
