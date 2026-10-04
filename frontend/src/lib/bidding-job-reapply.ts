import type { ApiBiddingJob } from '$lib/api-types';

export type BiddingJobReapplyPreviewRow = {
	job: ApiBiddingJob;
	changed: boolean;
	error?: string | null;
};

export function biddingJobReapplyTargetLabel(job: ApiBiddingJob): string {
	if (job.target.type === 'token') return `#${job.target.tokenId}`;
	if (job.target.targetTraits.length)
		return job.target.targetTraits.map((trait) => `${trait.type}=${trait.value}`).join(' + ');
	return 'collection';
}
