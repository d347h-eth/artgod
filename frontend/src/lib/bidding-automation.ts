import type {
	ApiBiddingBidBookRow,
	ApiBiddingJob,
	ApiCollectionBiddingTraitFilterJoinMode,
	ApiTraitFacet,
	ApiTradingTraitCriterion,
	ApiTokenAttribute,
	ApiTraitRangeFilter
} from '$lib/api-types';
import { bidBookRowEffectivePriceWei } from '$lib/bidding-bid-book-price';
import { BIDDING_AUTOMATION_PRICING_MODE } from './bidding-automation-contracts';
import {
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	TRADING_BIDDING_BID_SCOPE_KIND,
	type TokenBrowserStatus
} from '@artgod/shared/types';
export {
	BIDDING_AUTOMATION_PRICING_MODE,
	BIDDING_AUTOMATION_PRICING_MODE_LABEL,
	type BiddingAutomationPricingMode
} from './bidding-automation-contracts';

export const BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE = {
	FilteredTokens: 'filtered_tokens',
	ExplicitTokens: 'explicit_tokens',
	SelectedBid: 'selected_bid'
} as const;

export type BiddingAutomationSelectionSourceType =
	(typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE)[keyof typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE];

export const BIDDING_AUTOMATION_FILTER_SELECTION_STATE = {
	Clean: 'clean',
	VisibleTokenAdjustments: 'visible_token_adjustments'
} as const;

export type BiddingAutomationFilterSelectionState =
	(typeof BIDDING_AUTOMATION_FILTER_SELECTION_STATE)[keyof typeof BIDDING_AUTOMATION_FILTER_SELECTION_STATE];

export const BIDDING_AUTOMATION_FILTER_TARGET_INTENT = {
	TraitJob: 'trait_job',
	TokenBatch: 'token_batch'
} as const;

export type BiddingAutomationFilterTargetIntent =
	(typeof BIDDING_AUTOMATION_FILTER_TARGET_INTENT)[keyof typeof BIDDING_AUTOMATION_FILTER_TARGET_INTENT];

export const BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE = {
	TokenBrowser: 'token_browser',
	TokenOffers: 'token_offers'
} as const;

export type BiddingAutomationTokenFilterSource =
	(typeof BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE)[keyof typeof BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE];

export type BiddingAutomationTraitAttribute = ApiTokenAttribute & {
	marketplaceBiddingSupported: boolean;
};

export const BIDDING_AUTOMATION_DRAFT_TARGET_TYPE = {
	TokenBatch: 'token_batch',
	FilteredTokenBatch: 'filtered_token_batch',
	TraitJob: 'trait_job',
	UnsupportedTraitJob: 'unsupported_trait_job',
	CollectionJob: 'collection_job'
} as const;

export type BiddingAutomationDraftTargetType =
	(typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE)[keyof typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE];

// Captures token-filter state so backend can resolve all matching tokens across pages.
export type BiddingAutomationTokenFilterSnapshot = {
	source: BiddingAutomationTokenFilterSource;
	selectedTraits: BiddingAutomationTraitAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	tokenStatus?: TokenBrowserStatus | null;
	ownerAddress?: string | null;
	makerAddress?: string | null;
};

// Builds the canonical filter snapshot consumed by bidding selection and draft flows.
export function buildBiddingAutomationTokenFilterSnapshot(params: {
	source: BiddingAutomationTokenFilterSource;
	selectedTraits: BiddingAutomationTraitAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	tokenStatus?: TokenBrowserStatus | null;
	ownerAddress?: string | null;
	makerAddress?: string | null;
}): BiddingAutomationTokenFilterSnapshot {
	return {
		source: params.source,
		selectedTraits: params.selectedTraits,
		selectedTraitRanges: params.selectedTraitRanges,
		traitJoinMode: params.traitJoinMode,
		tokenStatus: params.tokenStatus ?? null,
		ownerAddress: params.ownerAddress ?? null,
		makerAddress: params.makerAddress ?? null
	};
}

// Builds a bidding filter snapshot by injecting backend-declared trait bidding support from facets.
export function buildBiddingAutomationResolvedTokenFilterSnapshot(params: {
	source: BiddingAutomationTokenFilterSource;
	selectedTraits: ApiTokenAttribute[];
	facets: ApiTraitFacet[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	tokenStatus?: TokenBrowserStatus | null;
	ownerAddress?: string | null;
	makerAddress?: string | null;
}): BiddingAutomationTokenFilterSnapshot {
	return buildBiddingAutomationTokenFilterSnapshot({
		source: params.source,
		selectedTraits: resolveBiddingAutomationTraitAttributes({
			selectedTraits: params.selectedTraits,
			facets: params.facets
		}),
		selectedTraitRanges: params.selectedTraitRanges,
		traitJoinMode: params.traitJoinMode,
		tokenStatus: params.tokenStatus,
		ownerAddress: params.ownerAddress,
		makerAddress: params.makerAddress
	});
}

// Represents a clean all-filtered-tokens action or a visible-page-adjusted variant.
export type BiddingAutomationFilteredTokenSelection = {
	type: typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens;
	targetIntent: BiddingAutomationFilterTargetIntent;
	filter: BiddingAutomationTokenFilterSnapshot;
	tokenCount: number;
	state:
		| {
				kind: typeof BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean;
		  }
		| {
				kind: typeof BIDDING_AUTOMATION_FILTER_SELECTION_STATE.VisibleTokenAdjustments;
				visibleTokenIds: string[];
		  };
};

// Represents exact token card picks made by the user.
export type BiddingAutomationExplicitTokenSelection = {
	type: typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens;
	tokenIds: string[];
};

// Represents a bid-book row selected as the template for a bidding draft.
export type BiddingAutomationSelectedBidSelection = {
	type: typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid;
	bid: ApiBiddingBidBookRow;
	existingJob?: ApiBiddingJob | null;
};

export type BiddingAutomationSelection =
	| BiddingAutomationFilteredTokenSelection
	| BiddingAutomationExplicitTokenSelection
	| BiddingAutomationSelectedBidSelection;

// Describes the durable job target that a UI selection is currently drafting.
export type BiddingAutomationDraftTarget =
	| {
			type: typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch;
			tokenIds: string[];
	  }
	| {
			type: typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch;
			tokenCount: number;
	  }
	| {
			type: typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob;
			traits: ApiTokenAttribute[];
			traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	  }
	| {
			type: typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob;
			traits: BiddingAutomationTraitAttribute[];
			traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	  }
	| {
			type: typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.CollectionJob;
	  };

// Keeps human-entered manual pricing in Ether units until submit-time parsing.
export type BiddingAutomationManualPricingDraft = {
	mode: typeof BIDDING_AUTOMATION_PRICING_MODE.Manual;
	floorEth: string;
	ceilingEth: string;
	deltaEth: string;
};

// References a collection pricing tier without losing the resolved preview values.
export type BiddingAutomationTierPricingDraft = {
	mode: typeof BIDDING_AUTOMATION_PRICING_MODE.Tier;
	tierId: string;
	resolvedFloorEth: string;
	resolvedCeilingEth: string;
	deltaEth: string;
};

export type BiddingAutomationPricingDraft =
	| BiddingAutomationManualPricingDraft
	| BiddingAutomationTierPricingDraft;

// Shared panel input for create/update flows across token detail and collection views.
export type BiddingAutomationDraft = {
	source: BiddingAutomationSelection;
	target: BiddingAutomationDraftTarget;
	pricing: BiddingAutomationPricingDraft;
	existingJob?: ApiBiddingJob | null;
};

export type BiddingJobTargetLookupRequestBody = {
	target:
		| {
				type: 'token';
				tokenId: string;
		  }
		| {
				type: 'collection';
				quantity?: number;
		  }
		| {
				type: 'trait';
				quantity?: number;
				targetTraits: ApiTradingTraitCriterion[];
		  };
};

// Builds a draft from an existing bid-book row without committing to a backend mutation path.
export function buildBiddingAutomationDraftFromBid(
	bid: ApiBiddingBidBookRow,
	existingJob: ApiBiddingJob | null = null
): BiddingAutomationDraft | null {
	const target = resolveDraftTargetFromBid(bid);
	if (!target) {
		return null;
	}
	return {
		source: {
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid,
			bid
		},
		target,
		pricing: {
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: existingJob?.config.floorEth ?? nextWinningBidEth(bid),
			ceilingEth: existingJob?.config.ceilingEth ?? nextWinningBidEth(bid),
			deltaEth: existingJob?.config.deltaEth ?? minimalBidDeltaEth(bid)
		},
		existingJob
	};
}

// Builds a token-scoped draft from the best applicable bid on a token detail page.
export function buildTokenBiddingAutomationDraftFromBid(
	bid: ApiBiddingBidBookRow,
	tokenId: string,
	existingJob: ApiBiddingJob | null = null
): BiddingAutomationDraft | null {
	const trimmedTokenId = tokenId.trim();
	if (!trimmedTokenId) {
		return null;
	}
	return {
		source: {
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid,
			bid
		},
		target: {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: [trimmedTokenId]
		},
		pricing: {
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: existingJob?.config.floorEth ?? nextWinningBidEth(bid),
			ceilingEth: existingJob?.config.ceilingEth ?? nextWinningBidEth(bid),
			deltaEth: existingJob?.config.deltaEth ?? minimalBidDeltaEth(bid)
		},
		existingJob
	};
}

// Picks the highest bid row for pricing a new bidding draft.
export function bestBiddingAutomationBid(
	bids: ApiBiddingBidBookRow[]
): ApiBiddingBidBookRow | null {
	return [...bids].sort(compareBiddingAutomationBidRows)[0] ?? null;
}

// Builds a draft from token-card/filter selection without materializing large clean filters in the UI.
export function buildBiddingAutomationDraftFromSelection(
	selection: BiddingAutomationSelection,
	existingJob: ApiBiddingJob | null = null
): BiddingAutomationDraft | null {
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid) {
		return buildBiddingAutomationDraftFromBid(selection.bid, selection.existingJob ?? existingJob);
	}

	const target = resolveDraftTargetFromSelection(selection);
	if (!target) {
		return null;
	}
	return {
		source: selection,
		target,
		pricing: {
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: existingJob?.config.floorEth ?? '',
			ceilingEth: existingJob?.config.ceilingEth ?? '',
			deltaEth: existingJob?.config.deltaEth ?? ''
		},
		existingJob
	};
}

// Builds a direct trait-job draft from a token detail trait row action.
export function buildTraitBiddingAutomationDraftFromTrait(params: {
	trait: BiddingAutomationTraitAttribute;
	tokenCount?: number | null;
	existingJob?: ApiBiddingJob | null;
}): BiddingAutomationDraft | null {
	return buildBiddingAutomationDraftFromSelection(
		{
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
			filter: buildBiddingAutomationTokenFilterSnapshot({
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [params.trait],
				selectedTraitRanges: [],
				traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
				tokenStatus: null,
				makerAddress: null
			}),
			tokenCount: params.tokenCount ?? 0,
			state: {
				kind: BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean
			}
		},
		params.existingJob ?? null
	);
}

// Attaches a target lookup result without mutating the route-local draft source.
export function withBiddingAutomationDraftExistingJob(
	draft: BiddingAutomationDraft | null,
	existingJob: ApiBiddingJob | null
): BiddingAutomationDraft | null {
	return draft ? { ...draft, existingJob } : null;
}

// Converts a draft target into the backend lookup contract for existing jobs.
export function buildBiddingJobTargetLookupRequestBody(
	draft: BiddingAutomationDraft | null
): BiddingJobTargetLookupRequestBody | null {
	if (!draft) {
		return null;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return draft.target.tokenIds.length === 1
			? buildTokenBiddingJobTargetLookupRequestBody(draft.target.tokenIds[0])
			: null;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
		return {
			target: {
				type: 'trait',
				quantity: selectedBidQuantity(draft),
				targetTraits: draft.target.traits.map((trait) => ({
					type: trait.key,
					value: trait.value
				}))
			}
		};
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob) {
		return null;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.CollectionJob) {
		return {
			target: {
				type: 'collection',
				quantity: selectedBidQuantity(draft)
			}
		};
	}
	return null;
}

// Builds the lookup body for one exact token-scoped bidding target.
export function buildTokenBiddingJobTargetLookupRequestBody(
	tokenId: string
): BiddingJobTargetLookupRequestBody {
	return {
		target: {
			type: 'token',
			tokenId
		}
	};
}

// Gates drafts to target kinds that currently have a backend mutation path.
export function isBiddingAutomationDraftSubmittable(draft: BiddingAutomationDraft | null): boolean {
	if (!draft) {
		return true;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return draft.target.tokenIds.length > 0;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
		return canSubmitFilteredTokenBatch(draft);
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob) {
		return false;
	}
	return true;
}

// Resolves the token ID required by the existing token job mutation API.
export function biddingAutomationDraftTokenId(draft: BiddingAutomationDraft | null): string | null {
	if (!draft || draft.target.type !== BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return null;
	}
	return draft.target.tokenIds[0] ?? null;
}

// Converts bid-book criteria into the trait-filter shape shared by controls and drafts.
export function biddingTraitCriteriaToTokenAttributes(
	traits: ApiTradingTraitCriterion[]
): ApiTokenAttribute[] {
	return traits.map((trait) => ({
		key: trait.type,
		value: trait.value
	}));
}

// Resolves selected trait filters against backend-provided facet marketplace bidding capability.
export function resolveBiddingAutomationTraitAttributes(params: {
	selectedTraits: ApiTokenAttribute[];
	facets: ApiTraitFacet[];
}): BiddingAutomationTraitAttribute[] {
	const supportByTrait = new Map<string, boolean>();
	for (const facet of params.facets) {
		for (const value of facet.values) {
			supportByTrait.set(
				traitSignature(facet.key, value.value),
				value.marketplaceBiddingSupported
			);
		}
	}
	return params.selectedTraits.map((trait) => ({
		...trait,
		marketplaceBiddingSupported: supportByTrait.get(traitSignature(trait.key, trait.value)) ?? false
	}));
}

// Keeps only traits known to be addressable through marketplace bidding APIs.
export function marketplaceBiddingSupportedTraits(
	traits: BiddingAutomationTraitAttribute[]
): ApiTokenAttribute[] {
	return traits
		.filter((trait) => trait.marketplaceBiddingSupported !== false)
		.map((trait) => ({
			key: trait.key,
			value: trait.value
		}));
}

function resolveDraftTargetFromBid(bid: ApiBiddingBidBookRow): BiddingAutomationDraftTarget | null {
	if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token && bid.scope.tokenId) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: [bid.scope.tokenId]
		};
	}
	if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: bid.scope.traits.map((trait) => ({
				key: trait.type,
				value: trait.value
			})),
			traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		};
	}
	if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.CollectionJob
		};
	}
	return null;
}

function compareBiddingAutomationBidRows(
	left: ApiBiddingBidBookRow,
	right: ApiBiddingBidBookRow
): number {
	const leftPrice = bidBookRowEffectivePriceWei(left);
	const rightPrice = bidBookRowEffectivePriceWei(right);
	if (leftPrice === rightPrice) {
		return left.orderId.localeCompare(right.orderId);
	}
	return leftPrice > rightPrice ? -1 : 1;
}

function resolveDraftTargetFromSelection(
	selection: BiddingAutomationSelection
): BiddingAutomationDraftTarget | null {
	if (selection.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: selection.tokenIds
		};
	}

	if (selection.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens) {
		return null;
	}

	if (selection.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.VisibleTokenAdjustments) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: selection.state.visibleTokenIds
		};
	}

	if (
		selection.targetIntent === BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob &&
		canDraftTraitJobFromFilters({
			selectedTraits: selection.filter.selectedTraits,
			selectedTraitRanges: selection.filter.selectedTraitRanges
		})
	) {
		const supportedTraits = marketplaceBiddingSupportedTraits(selection.filter.selectedTraits);
		if (supportedTraits.length === 0) {
			return {
				type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob,
				traits: selection.filter.selectedTraits,
				traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
			};
		}
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: supportedTraits,
			traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		};
	}

	return {
		type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch,
		tokenCount: selection.tokenCount
	};
}

export function canSubmitFilteredTokenBatch(draft: BiddingAutomationDraft): boolean {
	return (
		draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch &&
		draft.source.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens &&
		(draft.source.filter.source === BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers ||
			(draft.source.filter.tokenStatus !== null && draft.source.filter.tokenStatus !== undefined))
	);
}

// Allows trait-job drafting only for exact trait criteria that OpenSea can target directly.
export function canDraftTraitJobFromFilters(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
}): boolean {
	if (params.selectedTraits.length === 0 || params.selectedTraitRanges.length > 0) {
		return false;
	}
	return (
		new Set(params.selectedTraits.map((trait) => trait.key)).size === params.selectedTraits.length
	);
}

function selectedBidQuantity(draft: BiddingAutomationDraft): number | undefined {
	if (draft.source.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid) {
		return undefined;
	}
	const parsed = Number(draft.source.bid.quantity);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function traitSignature(key: string, value: string): string {
	return `${key}\u0000${value}`;
}

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

function nextWinningBidEth(bid: ApiBiddingBidBookRow): string {
	return formatWeiAsEth(bidBookRowEffectivePriceWei(bid) + minimalBidDeltaWei(bid));
}

function minimalBidDeltaEth(bid: ApiBiddingBidBookRow): string {
	return formatWeiAsEth(minimalBidDeltaWei(bid));
}

function minimalBidDeltaWei(bid: ApiBiddingBidBookRow): bigint {
	const effectiveWei = bidBookRowEffectivePriceWei(bid);
	if (effectiveWei <= 0n) {
		return 1n;
	}
	const priceMagnitude = ethOrderOfMagnitude(effectiveWei);
	const deltaWeiPower = 16 + priceMagnitude;
	return deltaWeiPower >= 0 ? 10n ** BigInt(deltaWeiPower) : 1n;
}

function ethOrderOfMagnitude(effectiveWei: bigint): number {
	if (effectiveWei >= WEI_PER_ETH) {
		return (effectiveWei / WEI_PER_ETH).toString().length - 1;
	}
	const fractionText = effectiveWei.toString().padStart(18, '0');
	const firstSignificantIndex = fractionText.search(/[1-9]/);
	return firstSignificantIndex === -1 ? -18 : -(firstSignificantIndex + 1);
}

function formatWeiAsEth(value: bigint): string {
	const whole = value / WEI_PER_ETH;
	const fraction = value % WEI_PER_ETH;
	if (fraction === 0n) {
		return whole.toString();
	}
	const fractionText = fraction.toString().padStart(18, '0').replace(/0+$/, '');
	return `${whole}.${fractionText}`;
}
