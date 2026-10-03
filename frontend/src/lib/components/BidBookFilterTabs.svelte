<script lang="ts" generics="Key extends string">
	import type { Snippet } from 'svelte';
	import type { BidBookFilterTab } from '$lib/bid-book-view-models';

	let {
		tabs,
		label,
		onSelect,
		hrefForKey,
		trailingActions,
		maxInlineSize
	}: {
		tabs: BidBookFilterTab<Key>[];
		label: string;
		trailingActions?: Snippet;
		maxInlineSize?: string;
	} & (
		| { onSelect: (key: Key | null) => void; hrefForKey?: never }
		| { hrefForKey: (key: Key | null) => string; onSelect?: never }
	) = $props();
</script>

{#if tabs.length > 0 || trailingActions}
	<div
		class="secondary-tabs bid-book-demand-tabs"
		role="group"
		aria-label={label}
		style:max-inline-size={maxInlineSize ? `min(100%, ${maxInlineSize})` : undefined}
	>
		{#each tabs as tab (tab.key)}
			{#if tab.active}
				<span class="secondary-tab-active" aria-current="true">{tab.label} [{tab.count}]</span>
			{:else if hrefForKey}
				<a href={hrefForKey(tab.key)} data-sveltekit-noscroll>{tab.label} [{tab.count}]</a>
			{:else}
				<button type="button" onclick={() => onSelect?.(tab.key)}>{tab.label} [{tab.count}]</button>
			{/if}
		{/each}
		{@render trailingActions?.()}
	</div>
{/if}
