import type { ApiBiddingBidBookRow } from '$lib/api-types';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import {
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	isTradingNumericTraitRange,
	type CollectionBiddingTraitFilterJoinMode
} from '@artgod/shared/types';
import { dedupeBiddingTraitCriteria } from '@artgod/shared/trading/offer-trait-criteria';
import { canRepresentTraitFilters } from '$lib/trait-filters';

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

// Existing browse ranges accept unsigned integers. Preserve the whole scope or
// omit the filter action when marketplace bounds cannot be represented there.
export function bidBookCriteriaToBrowseFilters(criteria: BidBookScopeTraits): {
	traits: ApiTokenAttribute[];
	traitRanges: ApiTraitRangeFilter[];
	traitJoinMode: CollectionBiddingTraitFilterJoinMode;
} | null {
	const scope = dedupeBiddingTraitCriteria(criteria);
	const hasRanges = scope.some(isTradingNumericTraitRange);
	// Browse accepts one range per key and cannot faithfully encode distinct
	// same-key conjunctions. Do not assume numeric metadata is single-valued.
	if (hasRanges && new Set(scope.map((criterion) => criterion.type)).size !== scope.length)
		return null;
	const traits: ApiTokenAttribute[] = [];
	const traitRanges: ApiTraitRangeFilter[] = [];
	for (const criterion of scope) {
		if (isTradingNumericTraitRange(criterion)) {
			if (
				!Number.isSafeInteger(criterion.min) ||
				!Number.isSafeInteger(criterion.max) ||
				criterion.min < 0 ||
				criterion.max < criterion.min
			)
				return null;
			traitRanges.push({
				key: criterion.type,
				fromValue: String(criterion.min),
				toValue: String(criterion.max)
			});
		} else {
			traits.push({ key: criterion.type, value: criterion.value });
		}
	}
	if (!canRepresentTraitFilters(traits, traitRanges)) return null;
	return {
		traits,
		traitRanges,
		traitJoinMode: hasRanges
			? COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
			: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
	};
}
