import type {
	ApiCollectionBiddingTraitFilterJoinMode,
	ApiTokenAttribute,
	ApiTokensPage,
	ApiTraitFacet,
	ApiTraitRangeFilter
} from '$lib/api-types';
import {
	type BiddingAutomationTokenFilterSnapshot,
	type BiddingAutomationTokenFilterSource,
	buildBiddingAutomationResolvedTokenFilterSnapshot
} from '$lib/bidding-automation';
import {
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	type TokenBrowserStatus
} from '@artgod/shared/types';

export type TokenBrowserBiddingFilterInput = {
	source: BiddingAutomationTokenFilterSource;
	selectedTraits: ApiTokenAttribute[];
	facets: ApiTraitFacet[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	tokenStatus?: TokenBrowserStatus | null;
	traitJoinMode?: ApiCollectionBiddingTraitFilterJoinMode;
	ownerAddress?: string | null;
	makerAddress?: string | null;
};

// Builds the bidding filter snapshot for token-browser-style surfaces.
export function buildTokenBrowserBiddingFilterSnapshot(
	params: TokenBrowserBiddingFilterInput
): BiddingAutomationTokenFilterSnapshot {
	return buildBiddingAutomationResolvedTokenFilterSnapshot({
		source: params.source,
		selectedTraits: params.selectedTraits,
		facets: params.facets,
		selectedTraitRanges: params.selectedTraitRanges,
		traitJoinMode: params.traitJoinMode ?? COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
		tokenStatus: params.tokenStatus ?? null,
		ownerAddress: params.ownerAddress ?? null,
		makerAddress: params.makerAddress ?? null
	});
}

// Produces a stable identity for clearing stale bidding selections after filter changes.
export function tokenBrowserBiddingFilterKey(
	params: Omit<TokenBrowserBiddingFilterInput, 'source' | 'facets'>
): string {
	return JSON.stringify({
		tokenStatus: params.tokenStatus ?? null,
		ownerAddress: params.ownerAddress ?? null,
		makerAddress: params.makerAddress ?? null,
		traitJoinMode: params.traitJoinMode ?? COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
		selectedTraits: params.selectedTraits,
		selectedTraitRanges: params.selectedTraitRanges
	});
}

// Lists visible token-card ids that are valid marketplace-bidding targets.
export function visibleBiddableTokenIds(tokens: ApiTokensPage): string[] {
	return tokens.items
		.filter((token) => token.marketplaceBiddingSupported)
		.map((token) => token.tokenId);
}
