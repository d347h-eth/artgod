import {
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import type {
	ApiBiddingJob,
	ApiChain,
	ApiCollection
} from '$lib/api-types';
import {
	archiveBiddingJob,
	lookupBiddingJobTarget,
	upsertBatchTokenBiddingJobs,
	upsertCollectionBiddingJob,
	upsertTokenBiddingJob,
	upsertTraitBiddingJob
} from '$lib/backend-api';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
	buildBiddingJobTargetLookupRequestBody,
	canSubmitFilteredTokenBatch,
	type BiddingAutomationDraft
} from '$lib/bidding-automation';
import type { EditableBiddingJobStatus } from '$lib/bidding-automation-panel-state';
export type { EditableBiddingJobStatus } from '$lib/bidding-automation-panel-state';

export type BiddingAutomationPricingRequest =
	| {
			priceTierId: string;
			deltaEth: string;
	  }
	| {
			floorEth: string;
			ceilingEth: string;
			deltaEth: string;
			priceTierId: null;
	  };

export type SaveBiddingAutomationDraftJobsInput = {
	fetchFn: typeof fetch;
	chainRef: string;
	collectionRef: string;
	draft: BiddingAutomationDraft | null;
	targetTokenId: string | null;
	nextStatus: EditableBiddingJobStatus;
	pricing: BiddingAutomationPricingRequest;
};

// Routes the current bidding draft to the one backend mutation matching its target shape.
export async function saveBiddingAutomationDraftJobs(
	input: SaveBiddingAutomationDraftJobsInput
): Promise<ApiBiddingJob[]> {
	const { fetchFn, chainRef, collectionRef, draft, targetTokenId, nextStatus, pricing } = input;
	if (!draft) {
		if (!targetTokenId) {
			throw new Error('target token is required');
		}
		const response = await upsertTokenBiddingJob(fetchFn, chainRef, collectionRef, targetTokenId, {
			status: nextStatus,
			...pricing
		});
		return [response.job];
	}

	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		if (draft.target.tokenIds.length === 1) {
			const response = await upsertTokenBiddingJob(
				fetchFn,
				chainRef,
				collectionRef,
				draft.target.tokenIds[0],
				{
					status: nextStatus,
					...pricing
				}
			);
			return [response.job];
		}
		const response = await upsertBatchTokenBiddingJobs(fetchFn, chainRef, collectionRef, {
			status: nextStatus,
			...pricing,
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds,
				tokenIds: draft.target.tokenIds
			}
		});
		return response.jobs;
	}

	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
		if (
			draft.source.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens ||
			!canSubmitFilteredTokenBatch(draft)
		) {
			throw new Error('filtered token selection is not available for submit');
		}
		if (draft.source.filter.source === BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers) {
			const response = await upsertBatchTokenBiddingJobs(fetchFn, chainRef, collectionRef, {
				status: nextStatus,
				...pricing,
				selection: {
					type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter,
					traits: draft.source.filter.selectedTraits,
					traitRanges: draft.source.filter.selectedTraitRanges,
					traitJoinMode: draft.source.filter.traitJoinMode,
					makerAddress: draft.source.filter.makerAddress
				}
			});
			return response.jobs;
		}
		const tokenStatus = draft.source.filter.tokenStatus;
		if (!tokenStatus) {
			throw new Error('filtered token selection is missing token status');
		}
		const response = await upsertBatchTokenBiddingJobs(fetchFn, chainRef, collectionRef, {
			status: nextStatus,
			...pricing,
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter,
				tokenStatus,
				traits: draft.source.filter.selectedTraits,
				traitRanges: draft.source.filter.selectedTraitRanges
			}
		});
		return response.jobs;
	}

	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
		const response = await upsertTraitBiddingJob(fetchFn, chainRef, collectionRef, {
			status: nextStatus,
			...pricing,
			quantity: selectedBidQuantity(draft),
			targetTraits: draft.target.traits.map((trait) => ({
				type: trait.key,
				value: trait.value
			}))
		});
		return [response.job];
	}

	const response = await upsertCollectionBiddingJob(fetchFn, chainRef, collectionRef, {
		status: nextStatus,
		...pricing,
		quantity: selectedBidQuantity(draft)
	});
	return [response.job];
}

export type LookupBiddingAutomationDraftTargetJobInput = {
	fetchFn: typeof fetch;
	chain: ApiChain | null;
	collection: ApiCollection | null;
	draft: BiddingAutomationDraft | null;
};

// Builds a stable lookup key before any network request so repeated effects can be deduped.
export function resolveBiddingAutomationDraftTargetLookupKey(
	input: Omit<LookupBiddingAutomationDraftTargetJobInput, 'fetchFn'>
): string {
	const { chain, collection, draft } = input;
	if (!chain || !collection || !draft || draft.existingJob) {
		return '';
	}

	const body = buildBiddingJobTargetLookupRequestBody(draft);
	return body ? `${chain.slug}:${collection.slug}:${JSON.stringify(body)}` : '';
}

// Looks up an existing declared job for a draft before the form decides between create/modify.
export async function lookupBiddingAutomationDraftTargetJob(
	input: LookupBiddingAutomationDraftTargetJobInput
): Promise<ApiBiddingJob | null> {
	const { fetchFn, chain, collection, draft } = input;
	if (!chain || !collection || !draft || draft.existingJob) {
		return null;
	}

	const body = buildBiddingJobTargetLookupRequestBody(draft);
	if (!body) {
		return null;
	}

	const response = await lookupBiddingJobTarget(fetchFn, chain.slug, collection.slug, body);
	return response.job;
}

// Archives a declared bidding job through the target-agnostic backend route.
export async function archiveBiddingAutomationJob(input: {
	fetchFn: typeof fetch;
	chainRef: string;
	collectionRef: string;
	jobId: string;
}): Promise<ApiBiddingJob> {
	const response = await archiveBiddingJob(
		input.fetchFn,
		input.chainRef,
		input.collectionRef,
		input.jobId
	);
	return response.job;
}

export function hasSubmittableBiddingTarget(input: {
	draft: BiddingAutomationDraft | null;
	targetTokenId: string | null;
}): boolean {
	const { draft, targetTokenId } = input;
	if (!draft) {
		return !!targetTokenId;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
		return draft.target.tokenIds.length > 0;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
		return (
			draft.source.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens &&
			draft.source.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean &&
			canSubmitFilteredTokenBatch(draft)
		);
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
		return draft.target.traits.length > 0;
	}
	if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob) {
		return false;
	}
	return true;
}

export function resolveBiddingSaveMessage(count: number, wasExistingJob: boolean): string {
	if (count <= 1) {
		return wasExistingJob ? 'modified' : 'created';
	}
	return `${count} jobs saved`;
}

function selectedBidQuantity(draft: BiddingAutomationDraft): number | undefined {
	if (draft.source.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid) {
		return undefined;
	}
	const parsed = Number(draft.source.bid.quantity);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
