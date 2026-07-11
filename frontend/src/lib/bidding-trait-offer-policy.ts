import type { ApiBiddingJob } from '$lib/api-types';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	type BiddingAutomationDraft
} from '$lib/bidding-automation';

// Explains how an operator enables live trait-scoped bidding in the effective runtime config.
export const BIDDING_TRAIT_OFFER_TRUST_REQUIRED_MESSAGE =
	'trait bidding disabled: enable trust OpenSea SignedZone for trait offers in Admin Config, then restart infra';

// Identifies draft or persisted targets whose exact criteria rely on OpenSea SignedZone.
export function isBiddingAutomationTraitTarget(input: {
	draft: BiddingAutomationDraft | null;
	job: ApiBiddingJob | null;
}): boolean {
	if (input.draft?.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
		return true;
	}
	const target = input.job?.target;
	return target !== undefined && 'targetTraits' in target && target.targetTraits.length > 0;
}
