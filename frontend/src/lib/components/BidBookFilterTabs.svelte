<script lang="ts" generics="Key extends string">
	import type { BidBookFilterTab } from '$lib/bid-book-view-models';

	let {
		tabs,
		label,
		onSelect,
		hrefForKey
	}: {
		tabs: BidBookFilterTab<Key>[];
		label: string;
	} & (
		| { onSelect: (key: Key | null) => void; hrefForKey?: never }
		| { hrefForKey: (key: Key | null) => string; onSelect?: never }
	) = $props();
</script>

{#if tabs.length > 0}
	<div class="secondary-tabs bid-book-demand-tabs" role="group" aria-label={label}>
		{#each tabs as tab (tab.key)}
			{#if tab.active}
				<span class="secondary-tab-active" aria-current="true">{tab.label} [{tab.count}]</span>
			{:else if hrefForKey}
				<a href={hrefForKey(tab.key)} data-sveltekit-noscroll>{tab.label} [{tab.count}]</a>
			{:else}
				<button type="button" onclick={() => onSelect?.(tab.key)}>{tab.label} [{tab.count}]</button>
			{/if}
		{/each}
	</div>
{/if}
