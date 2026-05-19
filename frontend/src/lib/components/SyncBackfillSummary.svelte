<script lang="ts">
	import type { ApiChain, ApiSyncBackfillRangeSummary } from '$lib/api-types';
	import {
		formatSyncBackfillAnchoredBlockDuration,
		formatSyncBackfillBlockRange,
		formatSyncBackfillInteger,
		formatSyncBackfillSyncedPercent,
		formatSyncBackfillUtc
	} from '$lib/sync-backfill-format';

	let {
		chain,
		range,
		ariaLabel = 'Sync summary'
	}: {
		chain: ApiChain;
		range: ApiSyncBackfillRangeSummary;
		ariaLabel?: string;
	} = $props();

	function observedDuration(): string {
		return formatSyncBackfillAnchoredBlockDuration({
			blockCount: range.blockCount,
			pageBlockCount: range.blockCount,
			pageDurationSeconds: range.time.durationSeconds,
			averageBlockTimeSeconds: chain.averageBlockTimeSeconds
		});
	}

	function bucketDuration(): string {
		return formatSyncBackfillAnchoredBlockDuration({
			blockCount: range.bucketSize,
			pageBlockCount: range.blockCount,
			pageDurationSeconds: range.time.durationSeconds,
			averageBlockTimeSeconds: chain.averageBlockTimeSeconds
		});
	}
</script>

<section class="sync-summary" aria-label={ariaLabel}>
	<div>
		<span class="sync-summary-label">observed</span>
		<span class="sync-summary-value">{formatSyncBackfillInteger(range.blockCount)}</span>
		<span class="sync-summary-meta">{observedDuration()}</span>
	</div>
	<div>
		<span class="sync-summary-label">range</span>
		<span class="sync-summary-value"
			>{formatSyncBackfillBlockRange(range.fromBlock, range.toBlock)}</span
		>
		<span class="sync-summary-meta sync-summary-date-stack">
			<span>{formatSyncBackfillUtc(range.time.from.timestamp)}</span>
			<span>{formatSyncBackfillUtc(range.time.to.timestamp)}</span>
		</span>
	</div>
	<div>
		<span class="sync-summary-label">bucket</span>
		<span class="sync-summary-value">{formatSyncBackfillInteger(range.bucketSize)}</span>
		<span class="sync-summary-meta">{bucketDuration()}</span>
	</div>
	<div>
		<span class="sync-summary-label">synced</span>
		<span class="sync-summary-value"
			>{formatSyncBackfillInteger(range.syncedBlockCount)}/{formatSyncBackfillInteger(
				range.blockCount
			)}</span
		>
		<span class="sync-summary-meta"
			>{formatSyncBackfillSyncedPercent(range.syncedBlockCount, range.blockCount)}</span
		>
	</div>
</section>
