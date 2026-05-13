<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ApiBiddingJob, ApiTradingTraitCriterion } from '$lib/api-types';
	import { buildTokenDetailHref } from '$lib/token-browser-query';

	let {
		chainRef,
		collectionBasePath,
		returnPath,
		returnQuery,
		mediaMode,
		job,
		imageCell
	}: {
		chainRef: string;
		collectionBasePath: string;
		returnPath: string;
		returnQuery: string;
		mediaMode: string | null;
		job: ApiBiddingJob;
		imageCell?: Snippet;
	} = $props();

	function formatEthLabel(value: string | null): string {
		if (value === null || value.trim().length === 0) {
			return '—';
		}
		return `${value} ETH`;
	}

	function formatTargetCriteria(criteria: ApiTradingTraitCriterion[]): string {
		if (criteria.length === 0) {
			return 'all tokens';
		}
		return criteria.map((criterion) => `${criterion.type}:${criterion.value}`).join(', ');
	}

	function targetSummary(): string {
		if (job.target.type === 'token') {
			return `token ${job.target.tokenId}`;
		}
		if (job.target.type === 'collection') {
			return `quantity ${job.target.quantity} · ${formatTargetCriteria(job.target.targetTraits)}`;
		}
		return `quantity ${job.target.quantity} · target ${formatTargetCriteria(job.target.targetTraits)} · competitors ${formatTargetCriteria(job.target.competitorTraits)}`;
	}

	function targetLabel(): string {
		if (job.target.type === 'token') {
			return 'token';
		}
		if (job.target.type === 'collection') {
			return 'collection scope';
		}
		return 'competitive trait';
	}

	function tokenHref(): string | null {
		if (job.target.type !== 'token') {
			return null;
		}
		return buildTokenDetailHref({
			basePath: collectionBasePath,
			tokenId: job.target.tokenId,
			mediaMode,
			returnPath,
			returnQuery
		});
	}

	function activeOrderLabel(): string {
		if (!job.runtime?.activeOrderId) {
			return '—';
		}
		return job.runtime.activeOrderId;
	}
</script>

<tr>
	<td class="bidding-image-cell">
		{#if imageCell}
			{@render imageCell()}
		{:else}
			<span class="muted">-</span>
		{/if}
	</td>
	<td class="bidding-target-cell">
		<div class="bidding-target-label mono">{targetLabel()}</div>
		{#if job.target.type === 'token'}
			<a class="token-table-id-link mono" href={tokenHref() ?? '#'}>token {job.target.tokenId}</a>
		{:else}
			<div class="bidding-target-summary">{targetSummary()}</div>
		{/if}
		<div class="muted">
			rev {job.revision} · updated <span class="mono">{job.updatedAt}</span>
		</div>
	</td>
	<td class="bidding-status-cell">
		<span class="mono">{job.status}</span>
	</td>
	<td class="bidding-config-cell">
		<span class="mono">{job.config.floorEth}</span>
	</td>
	<td class="bidding-config-cell">
		<span class="mono">{job.config.ceilingEth}</span>
	</td>
	<td class="bidding-config-cell">
		<span class="mono">{job.config.deltaEth}</span>
	</td>
	<td class="bidding-runtime-cell">
		<div class="bidding-runtime-lines">
			<div>
				<span class="runtime-k">current</span>
				<span class="runtime-v">{formatEthLabel(job.runtime?.currentPriceEth ?? null)}</span>
			</div>
			<div>
				<span class="runtime-k">active order</span>
				<span class="runtime-v mono">{activeOrderLabel()}</span>
			</div>
			<div>
				<span class="runtime-k">last run</span>
				<span class="runtime-v mono">{job.runtime?.lastRunAt ?? '—'}</span>
			</div>
			{#if job.runtime?.lastError}
				<p class="runtime-error bidding-row-error" role="alert">{job.runtime.lastError}</p>
			{/if}
		</div>
	</td>
</tr>
