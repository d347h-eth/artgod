import {
	TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import type { ApiBiddingJob } from '$lib/api-types';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	BIDDING_AUTOMATION_PRICING_MODE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	type BiddingAutomationDraft,
	type BiddingAutomationPricingMode
} from '$lib/bidding-automation';

const BIDDING_PANEL_KEY_PART = {
	EmptyJob: 'empty',
	NoDraft: 'no-draft'
} as const;

export type EditableBiddingJobStatus =
	| typeof TRADING_JOB_STATUS.Enabled
	| typeof TRADING_JOB_STATUS.Paused;

// Resolves which declared job the panel should edit for the current page-local job plus optional draft target.
export function resolveBiddingAutomationPanelJob(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
	lookedUpJob: ApiBiddingJob | null;
}): ApiBiddingJob | null {
	if (params.draft) {
		return params.draft.existingJob ?? params.lookedUpJob ?? null;
	}
	return params.job;
}

// Builds a stable key used to reset panel form state only when the loaded job or target draft changes.
export function resolveLoadedBiddingAutomationPanelKey(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
	lookedUpJob: ApiBiddingJob | null;
}): string {
	return `${resolveLoadedJobKey(resolveBiddingAutomationPanelJob(params))}:${resolveDraftKey(params.draft)}`;
}

// Resolves the initial pricing mode from persisted job config first, then the active draft.
export function resolveInitialBiddingAutomationPricingMode(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
}): BiddingAutomationPricingMode {
	if (params.job?.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier) {
		return BIDDING_AUTOMATION_PRICING_MODE.Tier;
	}
	if (params.draft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
		return BIDDING_AUTOMATION_PRICING_MODE.Tier;
	}
	return BIDDING_AUTOMATION_PRICING_MODE.Manual;
}

// Resolves the initial selected price tier from persisted job config first, then the active draft.
export function resolveInitialBiddingAutomationPriceTierId(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
}): string {
	if (params.job?.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier) {
		return params.job.config.pricingSource.tierId;
	}
	if (params.draft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
		return params.draft.pricing.tierId;
	}
	return '';
}

// Resolves the panel lifecycle intent from the existing job, defaulting new drafts to enabled.
export function resolveInitialBiddingAutomationStatus(
	job: ApiBiddingJob | null
): EditableBiddingJobStatus {
	return job?.status === TRADING_JOB_STATUS.Paused
		? TRADING_JOB_STATUS.Paused
		: TRADING_JOB_STATUS.Enabled;
}

// Resolves the initial manual floor value from persisted job config first, then the active draft.
export function resolveInitialBiddingAutomationFloorEth(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
}): string {
	if (params.job?.config.floorEth) {
		return params.job.config.floorEth;
	}
	if (params.draft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
		return params.draft.pricing.floorEth;
	}
	return '';
}

// Resolves the initial manual ceiling value from persisted job config first, then the active draft.
export function resolveInitialBiddingAutomationCeilingEth(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
}): string {
	if (params.job?.config.ceilingEth) {
		return params.job.config.ceilingEth;
	}
	if (params.draft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
		return params.draft.pricing.ceilingEth;
	}
	return '';
}

// Resolves the initial delta from persisted job config, active draft, or collection default.
export function resolveInitialBiddingAutomationDeltaEth(params: {
	job: ApiBiddingJob | null;
	draft: BiddingAutomationDraft | null;
	defaultDeltaEth: string;
}): string {
	if (params.job?.config.deltaEth) {
		return params.job.config.deltaEth;
	}
	if (params.draft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
		return params.draft.pricing.deltaEth || params.defaultDeltaEth;
	}
	if (params.draft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
		return params.draft.pricing.deltaEth;
	}
	return params.defaultDeltaEth;
}

// Returns the price tier ID backing a persisted job, when it is tier-priced.
export function biddingAutomationJobPriceTierId(job: ApiBiddingJob): string | null {
	return job.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier
		? job.config.pricingSource.tierId
		: null;
}

// Checks whether the current form state differs from the loaded job or empty default form.
export function hasBiddingAutomationPanelDraftChanges(params: {
	currentJob: ApiBiddingJob | null;
	status: EditableBiddingJobStatus;
	pricingMode: BiddingAutomationPricingMode;
	selectedPriceTierId: string;
	displayedFloorEth: string;
	displayedCeilingEth: string;
	displayedDeltaEth: string;
	floorEth: string;
	ceilingEth: string;
	deltaEth: string;
}): boolean {
	if (params.currentJob) {
		if (params.pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
			return (
				params.status !== resolveInitialBiddingAutomationStatus(params.currentJob) ||
				params.selectedPriceTierId !== biddingAutomationJobPriceTierId(params.currentJob) ||
				params.displayedFloorEth.trim() !== params.currentJob.config.floorEth ||
				params.displayedCeilingEth.trim() !== params.currentJob.config.ceilingEth ||
				params.displayedDeltaEth.trim() !== params.currentJob.config.deltaEth
			);
		}
		return (
			params.status !== resolveInitialBiddingAutomationStatus(params.currentJob) ||
			params.currentJob.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier ||
			params.floorEth.trim() !== params.currentJob.config.floorEth ||
			params.ceilingEth.trim() !== params.currentJob.config.ceilingEth ||
			params.deltaEth.trim() !== params.currentJob.config.deltaEth
		);
	}

	return (
		params.status !== TRADING_JOB_STATUS.Enabled ||
		params.pricingMode !== BIDDING_AUTOMATION_PRICING_MODE.Manual ||
		params.displayedFloorEth.trim().length > 0 ||
		params.displayedCeilingEth.trim().length > 0 ||
		params.deltaEth.trim().length > 0
	);
}

function resolveLoadedJobKey(job: ApiBiddingJob | null): string {
	if (!job) {
		return BIDDING_PANEL_KEY_PART.EmptyJob;
	}
	return [
		job.jobId,
		job.revision,
		job.status,
		job.config.floorEth,
		job.config.ceilingEth,
		job.config.deltaEth
	].join(':');
}

function resolveDraftKey(draft: BiddingAutomationDraft | null): string {
	if (!draft) {
		return BIDDING_PANEL_KEY_PART.NoDraft;
	}
	return [
		draft.source.type,
		draft.source.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid
			? draft.source.bid.orderId
			: '',
		draft.target.type,
		resolveDraftTargetIdentityKey(draft),
		draft.pricing.mode,
		draft.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? draft.pricing.floorEth : '',
		draft.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual
			? draft.pricing.ceilingEth
			: '',
		draft.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? draft.pricing.deltaEth : '',
		draft.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier ? draft.pricing.tierId : ''
	].join(':');
}

// Distinguishes draft targets with the same display count but different submit payloads.
function resolveDraftTargetIdentityKey(draft: BiddingAutomationDraft): string {
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return draft.target.tokenIds.join('\u0000');
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
		return [
			draft.target.tokenCount,
			draft.source.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens
				? resolveFilterIdentityKey(draft.source.filter)
				: ''
		].join('\u0000');
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
		return draft.target.traits
			.map((trait) => `${trait.key}=${trait.value}`)
			.sort((left, right) => left.localeCompare(right))
			.join('\u0000');
	}
	return BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.CollectionJob;
}

function resolveFilterIdentityKey(
	filter: Extract<
		BiddingAutomationDraft['source'],
		{ type: typeof BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens }
	>['filter']
): string {
	return [
		filter.source,
		filter.tokenStatus ?? '',
		filter.makerAddress ?? '',
		filter.traitJoinMode,
		...filter.selectedTraits
			.map((trait) => `${trait.key}=${trait.value}`)
			.sort((left, right) => left.localeCompare(right)),
		...filter.selectedTraitRanges
			.map((range) => `${range.key}:${range.fromValue ?? ''}:${range.toValue ?? ''}`)
			.sort((left, right) => left.localeCompare(right))
	].join('\u0000');
}
