<script lang="ts">
	import type { ActivityFeedFilterKind } from '@artgod/shared/types';
	import type { Snippet } from 'svelte';
	import type { CollectionExtensionNavigationPageTarget } from '$lib/collection-extension-navigation';
	import type { CollectionNavigation } from '$lib/collection-navigation';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import type { ApiActivityExtensionEventRef } from '$lib/api-types';
	import type { CollectionTokenStatus } from '$lib/token-browser-query';

	let {
		navigation,
		activeSection,
		activeTokenStatus = null,
		activeActivityKind = null,
		activeActivityExtensionEvent = null,
		activeExtensionPage = null,
		collectionAvailable = true,
		showCustomization = true,
		breadcrumbs,
		headerActions,
		topActions,
		children
	}: {
		navigation: CollectionNavigation;
		activeSection:
			| 'tokens'
			| 'activities'
			| 'holders'
			| 'customization'
			| 'bidding'
			| 'blockspace'
			| 'extension-page'
			| null;
		activeTokenStatus?: CollectionTokenStatus | null;
		activeActivityKind?: ActivityFeedFilterKind | null;
		activeActivityExtensionEvent?: ApiActivityExtensionEventRef | null;
		activeExtensionPage?: CollectionExtensionNavigationPageTarget | null;
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
					{navigation}
					active={activeSection}
					{activeTokenStatus}
					{activeActivityKind}
					{activeActivityExtensionEvent}
					{activeExtensionPage}
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
