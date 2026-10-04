<script lang="ts">
	import type { ApiBiddingPriceTierReapplyJobPreview } from '$lib/api-types';
	import BiddingJobReapplyPreview from './BiddingJobReapplyPreview.svelte';

	let {
		jobs,
		selectedJobIds,
		applying = false,
		armedActionKey = null,
		onToggleJob,
		onApply
	}: {
		jobs: ApiBiddingPriceTierReapplyJobPreview[];
		selectedJobIds: string[];
		applying?: boolean;
		armedActionKey?: string | null;
		onToggleJob: (jobId: string) => void;
		onApply: () => void | Promise<void>;
	} = $props();
	const columns = ['floor', 'ceiling', 'delta'].map((label) => ({
		label,
		right: true,
		format: (preview: ApiBiddingPriceTierReapplyJobPreview) => {
			const field = `${label}Eth` as 'floorEth' | 'ceilingEth' | 'deltaEth';
			return `${preview.before[field]} -> ${preview.after[field]}`;
		}
	}));
</script>

<BiddingJobReapplyPreview
	{jobs}
	{selectedJobIds}
	{applying}
	{armedActionKey}
	{onToggleJob}
	{onApply}
	{columns}
	label="tier reapply preview"
	emptyLabel="no tier-backed jobs"
	selectionLabel="tier reapply"
	actionAttribute="data-price-tier-action"
/>
