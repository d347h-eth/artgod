import type {
	ApiBiddingBidBookRow,
	ApiBiddingJob,
	ApiCollectionBiddingTraitFilterJoinMode,
	ApiTokenAttribute,
	ApiTraitRangeFilter
} from '$lib/api-types';
import type { TokenBrowserStatus } from '@artgod/shared/types/browse';

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

export const BIDDING_AUTOMATION_DRAFT_TARGET_TYPE = {
	TokenBatch: 'token_batch',
	FilteredTokenBatch: 'filtered_token_batch',
	TraitJob: 'trait_job',
	CollectionJob: 'collection_job'
} as const;

export type BiddingAutomationDraftTargetType =
	(typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE)[keyof typeof BIDDING_AUTOMATION_DRAFT_TARGET_TYPE];

export const BIDDING_AUTOMATION_PRICING_MODE = {
	Manual: 'manual',
	Tier: 'tier'
} as const;

export type BiddingAutomationPricingMode =
	(typeof BIDDING_AUTOMATION_PRICING_MODE)[keyof typeof BIDDING_AUTOMATION_PRICING_MODE];

// Captures token-filter state so backend can resolve all matching tokens across pages.
export type BiddingAutomationTokenFilterSnapshot = {
	source: BiddingAutomationTokenFilterSource;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	tokenStatus?: TokenBrowserStatus | null;
	makerAddress?: string | null;
};

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
			floorEth: nextWinningBidEth(bid),
			ceilingEth: nextWinningBidEth(bid),
			deltaEth: existingJob?.config.deltaEth ?? minimalBidDeltaEth(bid)
		},
		existingJob
	};
}

// Builds a draft from token-card/filter selection without materializing large clean filters in the UI.
export function buildBiddingAutomationDraftFromSelection(
	selection: BiddingAutomationSelection,
	existingJob: ApiBiddingJob | null = null
): BiddingAutomationDraft | null {
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

// Gates drafts to target kinds that currently have a backend mutation path.
export function isBiddingAutomationDraftSubmittable(
	draft: BiddingAutomationDraft | null
): boolean {
	if (!draft) {
		return true;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return draft.target.tokenIds.length > 0;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
		return canSubmitFilteredTokenBatch(draft);
	}
	return true;
}

// Resolves the token ID required by the existing token job mutation API.
export function biddingAutomationDraftTokenId(
	draft: BiddingAutomationDraft | null
): string | null {
	if (!draft || draft.target.type !== BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return null;
	}
	return draft.target.tokenIds[0] ?? null;
}

function resolveDraftTargetFromBid(bid: ApiBiddingBidBookRow): BiddingAutomationDraftTarget | null {
	if (bid.scope.kind === 'token' && bid.scope.tokenId) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: [bid.scope.tokenId]
		};
	}
	if (bid.scope.kind === 'trait') {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: bid.scope.traits.map((trait) => ({
				key: trait.type,
				value: trait.value
			})),
			traitJoinMode: 'and'
		};
	}
	if (bid.scope.kind === 'collection') {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.CollectionJob
		};
	}
	return null;
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
			selectedTraitRanges: selection.filter.selectedTraitRanges,
			traitJoinMode: selection.filter.traitJoinMode
		})
	) {
		return {
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: selection.filter.selectedTraits,
			traitJoinMode: selection.filter.traitJoinMode
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

// Allows trait-job drafting only for exact AND-compatible trait criteria.
export function canDraftTraitJobFromFilters(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode?: ApiCollectionBiddingTraitFilterJoinMode;
}): boolean {
	if (params.selectedTraits.length === 0 || params.selectedTraitRanges.length > 0) {
		return false;
	}
	if (params.selectedTraits.length > 1 && params.traitJoinMode && params.traitJoinMode !== 'and') {
		return false;
	}
	return new Set(params.selectedTraits.map((trait) => trait.key)).size === params.selectedTraits.length;
}

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

function nextWinningBidEth(bid: ApiBiddingBidBookRow): string {
	return formatWeiAsEth(BigInt(bid.priceWei) + minimalBidDeltaWei(bid));
}

function minimalBidDeltaEth(bid: ApiBiddingBidBookRow): string {
	return formatWeiAsEth(minimalBidDeltaWei(bid));
}

function minimalBidDeltaWei(bid: ApiBiddingBidBookRow): bigint {
	const priceWei = BigInt(bid.priceWei);
	const deltaWei = priceWei / 100n;
	return deltaWei > 0n ? deltaWei : 1n;
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
