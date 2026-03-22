<script lang="ts">
	import type { Snippet } from 'svelte';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';

	let {
		tokensHref,
		activitiesHref,
		holdersHref,
		activeSection,
		collectionAvailable = true,
		breadcrumbs,
		topActions,
		children
	}: {
		tokensHref: string;
		activitiesHref: string;
		holdersHref: string;
		activeSection: 'tokens' | 'activities' | 'holders';
		collectionAvailable?: boolean;
		breadcrumbs: Snippet;
		topActions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		{@render breadcrumbs()}
	</nav>

	<header class="panel-header">
		{#if collectionAvailable}
			<CollectionSectionTabs {tokensHref} {activitiesHref} {holdersHref} active={activeSection} />
		{:else}
			<span class="muted">collection not found</span>
		{/if}
	</header>

	{#if topActions}
		<div class="panel-top-actions panel-top-actions-stack">
			{@render topActions()}
		</div>
	{/if}

	{@render children()}
</section>
