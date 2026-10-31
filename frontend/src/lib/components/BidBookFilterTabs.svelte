<script lang="ts" generics="Key extends string">
	import type { Snippet } from 'svelte';
	import type { BidBookFilterTab } from '$lib/bid-book-view-models';

	let {
		tabs,
		label,
		onSelect,
		hrefForKey,
		trailingActions,
		maxInlineSize,
		labelMaxInlineSize
	}: {
		tabs: BidBookFilterTab<Key>[];
		label: string;
		trailingActions?: Snippet;
		maxInlineSize?: string;
		labelMaxInlineSize?: string;
	} & (
		| { onSelect: (key: Key | null) => void; hrefForKey?: never }
		| { hrefForKey: (key: Key | null) => string; onSelect?: never }
	) = $props();
</script>

{#snippet tabLabel(tab: BidBookFilterTab<Key>)}
	{#if labelMaxInlineSize}
		<bdi class="filter-tab-label" style:max-inline-size={labelMaxInlineSize}>{tab.label}</bdi>
		[{tab.count}]
	{:else}
		{tab.label} [{tab.count}]
	{/if}
{/snippet}

{#if tabs.length > 0 || trailingActions}
	<div
		class="secondary-tabs bid-book-demand-tabs"
		role="group"
		aria-label={label}
		style:max-inline-size={maxInlineSize ? `min(100%, ${maxInlineSize})` : undefined}
	>
		{#each tabs as tab (tab.key)}
			{#if tab.active}
				<span
					class="secondary-tab-active"
					aria-current="true"
					title={labelMaxInlineSize ? tab.label : undefined}
				>{@render tabLabel(tab)}</span>
			{:else if hrefForKey}
				<a
					href={hrefForKey(tab.key)}
					data-sveltekit-reset="false"
					title={labelMaxInlineSize ? tab.label : undefined}
				>{@render tabLabel(tab)}</a>
			{:else}
				<button
					type="button"
					onclick={() => onSelect?.(tab.key)}
					title={labelMaxInlineSize ? tab.label : undefined}
				>{@render tabLabel(tab)}</button>
			{/if}
		{/each}
		{@render trailingActions?.()}
	</div>
{/if}

<style>
	.filter-tab-label {
		min-inline-size: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-inline-end: 0.4em;
	}
</style>
