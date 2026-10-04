<script lang="ts" generics="Preview extends BiddingJobReapplyPreviewRow">
	import { BIDDING_JOB_REAPPLY_ACTION_KEY } from '$lib/action-confirmation';
	import {
		biddingJobReapplyTargetLabel,
		type BiddingJobReapplyPreviewRow
	} from '$lib/bidding-job-reapply';

	let {
		jobs,
		selectedJobIds,
		applying = false,
		disabled = false,
		armedActionKey = null,
		onToggleJob,
		onApply,
		label,
		emptyLabel,
		selectionLabel,
		actionAttribute,
		columns
	}: {
		jobs: Preview[];
		selectedJobIds: string[];
		applying?: boolean;
		disabled?: boolean;
		armedActionKey?: string | null;
		onToggleJob: (jobId: string) => void;
		onApply: () => void | Promise<void>;
		label: string;
		emptyLabel: string;
		selectionLabel: string;
		actionAttribute: string;
		columns: { label: string; right?: boolean; format: (preview: Preview) => string }[];
	} = $props();
	const selectedJobIdSet = $derived(new Set(selectedJobIds));
	const changedJobs = $derived(jobs.filter((job) => job.changed));
</script>

<section class="bidding-price-tier-reapply-preview" aria-label={label}>
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
		<p class="muted bid-book-empty">{emptyLabel}</p>
	{:else}
		<div class="table-wrap bidding-price-tier-table-wrap">
			<table class="bidding-price-tier-table bidding-price-tier-reapply-table">
				<thead>
					<tr>
						<th>apply</th>
						<th>target</th>
						{#each columns as column}
							<th>{column.label}</th>
						{/each}
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
									disabled={applying || disabled || !preview.changed || Boolean(preview.error)}
									onchange={() => onToggleJob(preview.job.jobId)}
									aria-label={`select ${biddingJobReapplyTargetLabel(preview.job)} for ${selectionLabel}`}
								/>
							</td>
							<td class="mono">{biddingJobReapplyTargetLabel(preview.job)}</td>
							{#each columns as column}
								<td class="mono" class:tier-cell-right={column.right}>{column.format(preview)}</td>
							{/each}
							<td class="mono tier-cell-center" class:runtime-error={Boolean(preview.error)}>
								{preview.error ?? (preview.changed ? 'changed' : 'same')}
							</td>
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
			class:token-bidding-action-armed={armedActionKey === BIDDING_JOB_REAPPLY_ACTION_KEY}
			{...{ [actionAttribute]: BIDDING_JOB_REAPPLY_ACTION_KEY }}
			onclick={() => void onApply()}
			disabled={applying || disabled || selectedJobIds.length === 0}
		>
			{applying ? 'applying...' : 'apply'}
		</button>
	</div>
</section>
