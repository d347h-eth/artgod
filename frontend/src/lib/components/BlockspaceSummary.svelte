<script lang="ts">
	import type { ApiChain, ApiBlockspaceRangeSummary } from '$lib/api-types';
	import {
		formatBlockspaceAnchoredBlockDuration,
		formatBlockspaceBlockRange,
		formatBlockspaceInteger,
		formatBlockspaceSyncedPercent,
		formatBlockspaceUtc
	} from '$lib/blockspace-format';

	let {
		chain,
		range,
		ariaLabel = 'Sync summary',
		observedLabel = 'observed'
	}: {
		chain: ApiChain;
		range: ApiBlockspaceRangeSummary;
		ariaLabel?: string;
		observedLabel?: string;
	} = $props();

	let isSingleBlock = $derived(range.fromBlock === range.toBlock);

	function observedDuration(): string {
		return formatBlockspaceAnchoredBlockDuration({
			blockCount: range.blockCount,
			pageBlockCount: range.blockCount,
			pageDurationSeconds: range.time.durationSeconds,
			averageBlockTimeSeconds: chain.averageBlockTimeSeconds
		});
	}

	function bucketDuration(): string {
		return formatBlockspaceAnchoredBlockDuration({
			blockCount: range.bucketSize,
			pageBlockCount: range.blockCount,
			pageDurationSeconds: range.time.durationSeconds,
			averageBlockTimeSeconds: chain.averageBlockTimeSeconds
		});
	}
</script>

<section class="blockspace-summary" aria-label={ariaLabel}>
	<div>
		<span class="blockspace-summary-label">{observedLabel}</span>
		<span class="blockspace-summary-value">{formatBlockspaceInteger(range.blockCount)}</span>
		<span class="blockspace-summary-meta">{observedDuration()}</span>
	</div>
	<div>
		{#if isSingleBlock}
			<span class="blockspace-summary-label">block</span>
			<span class="blockspace-summary-value">{formatBlockspaceInteger(range.fromBlock)}</span>
			<span class="blockspace-summary-meta">{formatBlockspaceUtc(range.time.from.timestamp)}</span>
		{:else}
			<span class="blockspace-summary-label">range</span>
			<span class="blockspace-summary-value"
				>{formatBlockspaceBlockRange(range.fromBlock, range.toBlock)}</span
			>
			<span class="blockspace-summary-meta blockspace-summary-date-stack">
				<span>{formatBlockspaceUtc(range.time.from.timestamp)}</span>
				<span>{formatBlockspaceUtc(range.time.to.timestamp)}</span>
			</span>
		{/if}
	</div>
	{#if !isSingleBlock}
		<div>
			<span class="blockspace-summary-label">bucket</span>
			<span class="blockspace-summary-value">{formatBlockspaceInteger(range.bucketSize)}</span>
			<span class="blockspace-summary-meta">{bucketDuration()}</span>
		</div>
	{/if}
	<div>
		<span class="blockspace-summary-label">synced</span>
		<span class="blockspace-summary-value"
			>{formatBlockspaceInteger(range.syncedBlockCount)}/{formatBlockspaceInteger(
				range.blockCount
			)}</span
		>
		<span class="blockspace-summary-meta"
			>{formatBlockspaceSyncedPercent(range.syncedBlockCount, range.blockCount)}</span
		>
	</div>
</section>
