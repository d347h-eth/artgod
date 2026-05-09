<script lang="ts">
	import type { ActivityExtensionCellProps } from '$lib/activity-extension-views/types';
	import { TERRAFORMS_TOKEN_ID_CELL_LABELS } from '$lib/activity-extension-views/terraforms/constants';
	import FilterIcon from '$lib/components/FilterIcon.svelte';

	let { activity, hrefs }: ActivityExtensionCellProps = $props();
	let tokenId = $derived(activity.tokenId?.trim() || null);

	function filterLabel(id: string): string {
		return `${TERRAFORMS_TOKEN_ID_CELL_LABELS.FilterToken} ${id}`;
	}
</script>

{#if tokenId}
	<span class="terraforms-token-id-cell">
		<a class="terraforms-token-id-link" href={hrefs.tokenDetail(tokenId)}>{tokenId}</a>
		<a
			class="terraforms-token-id-filter"
			href={hrefs.filter({ tokenId })}
			title={filterLabel(tokenId)}
			aria-label={filterLabel(tokenId)}
		>
			<FilterIcon />
		</a>
	</span>
{:else}
	<span class="muted">-</span>
{/if}

<style>
	.terraforms-token-id-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		white-space: nowrap;
	}

	.terraforms-token-id-link {
		font-variant-numeric: tabular-nums;
	}

	.terraforms-token-id-filter {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		color: var(--c-blue);
	}

	.terraforms-token-id-filter:hover,
	.terraforms-token-id-filter:focus-visible {
		color: var(--c-yellow);
	}
</style>
