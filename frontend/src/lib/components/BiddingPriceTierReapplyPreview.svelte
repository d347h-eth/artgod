<script lang="ts">
	import type { ApiBiddingJob, ApiBiddingPriceTierReapplyJobPreview } from '$lib/api-types';

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

	const selectedJobIdSet = $derived(new Set(selectedJobIds));
	const changedJobs = $derived(jobs.filter((job) => job.changed));
	const applyActionKey = 'reapply:form';

	function targetLabel(job: ApiBiddingJob): string {
		if (job.target.type === 'token') {
			return `#${job.target.tokenId}`;
		}
		if (job.target.type === 'collection' && job.target.targetTraits.length > 0) {
			return job.target.targetTraits.map((trait) => `${trait.type}=${trait.value}`).join(' + ');
		}
		if (job.target.type === 'competitiveTrait') {
			return job.target.targetTraits.map((trait) => `${trait.type}=${trait.value}`).join(' + ');
		}
		return 'collection';
	}
</script>

<section class="bidding-price-tier-reapply-preview" aria-label="tier reapply preview">
	<div class="runtime-kv-grid bid-book-meta">
		<div>
			<span class="runtime-k">affected</span>
			<span class="runtime-v">{jobs.length}</span>
		</div>
		<div>
			<span class="runtime-k">changed</span>
			<span class="runtime-v">{changedJobs.length}</span>
		</div>
		<div>
			<span class="runtime-k">selected</span>
			<span class="runtime-v">{selectedJobIds.length}</span>
		</div>
	</div>

	{#if jobs.length === 0}
		<p class="muted bid-book-empty">no tier-backed jobs</p>
	{:else}
		<div class="table-wrap bidding-price-tier-table-wrap">
			<table class="bidding-price-tier-table bidding-price-tier-reapply-table">
				<thead>
					<tr>
						<th>apply</th>
						<th>target</th>
						<th>floor</th>
						<th>ceiling</th>
						<th>delta</th>
						<th>state</th>
					</tr>
				</thead>
				<tbody>
					{#each jobs as preview (preview.job.jobId)}
						<tr>
							<td class="tier-cell-center">
								<input
									type="checkbox"
									checked={selectedJobIdSet.has(preview.job.jobId)}
									disabled={applying || !preview.changed}
									onchange={() => onToggleJob(preview.job.jobId)}
									aria-label={`select ${targetLabel(preview.job)} for tier reapply`}
								/>
							</td>
							<td class="mono">{targetLabel(preview.job)}</td>
							<td class="mono tier-cell-right">
								{preview.before.floorEth} -> {preview.after.floorEth}
							</td>
							<td class="mono tier-cell-right">
								{preview.before.ceilingEth} -> {preview.after.ceilingEth}
							</td>
							<td class="mono tier-cell-right">
								{preview.before.deltaEth} -> {preview.after.deltaEth}
							</td>
							<td class="mono tier-cell-center">{preview.changed ? 'changed' : 'same'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<div class="bidding-price-tier-reapply-actions">
		<button
			type="button"
			class="token-bidding-action-positive"
			class:token-bidding-action-armed={armedActionKey === applyActionKey}
			data-price-tier-action={applyActionKey}
			onclick={() => void onApply()}
			disabled={applying || selectedJobIds.length === 0}
		>
			{applying ? 'applying...' : 'apply'}
		</button>
	</div>
</section>
