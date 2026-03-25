<script lang="ts">
	import type { Snippet } from 'svelte';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';

	let {
		tokensHref,
		activitiesHref,
		holdersHref,
		customizationHref,
		activeSection,
		collectionAvailable = true,
		showCustomization = true,
		breadcrumbs,
		headerActions,
		topActions,
		children
	}: {
		tokensHref: string;
		activitiesHref: string;
		holdersHref: string;
		customizationHref: string;
		activeSection: 'tokens' | 'activities' | 'holders' | 'customization' | null;
		collectionAvailable?: boolean;
		showCustomization?: boolean;
		breadcrumbs: Snippet;
		headerActions?: Snippet;
		topActions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		{@render breadcrumbs()}
	</nav>

	<header class="panel-header">
		<div class="panel-header-main">
			{#if collectionAvailable}
				<CollectionSectionTabs
					{tokensHref}
					{activitiesHref}
					{holdersHref}
					{customizationHref}
					active={activeSection}
					{showCustomization}
				/>
			{:else}
				<span class="muted">collection not found</span>
			{/if}
		</div>
		{#if headerActions}
			<div class="panel-header-right">
				{@render headerActions()}
			</div>
		{/if}
	</header>

	{#if topActions}
		<div class="panel-top-actions panel-top-actions-stack">
			{@render topActions()}
		</div>
	{/if}

	{@render children()}
</section>
