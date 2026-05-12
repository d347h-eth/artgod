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

export const BIDDING_AUTOMATION_DRAFT_TARGET_TYPE = {
	TokenBatch: 'token_batch',
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
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	tokenStatus?: TokenBrowserStatus | null;
	makerAddress?: string | null;
};

// Represents a clean all-filtered-tokens action or a visible-page-adjusted variant.
export type BiddingAutomationFilteredTokenSelection = {
	type: typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens;
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
