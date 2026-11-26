<script lang="ts">
	import { useCollectionView } from '$lib/collection-view-context';
	import { page } from '$app/state';
	import CollectionViewPicker from './CollectionViewPicker.svelte';
	import type { Snippet } from 'svelte';
	import type { CollectionNavigation, CollectionSectionSelection } from '$lib/collection-navigation';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import { COLLECTION_PAGE_TOP_ACTIONS_DOM } from '$lib/components/collection-page-layout-dom';

	const collectionViewPage = useCollectionView();
	const viewContext = $derived(collectionViewPage());

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
	}: CollectionSectionSelection & {
		navigation: CollectionNavigation;
		collectionAvailable?: boolean;
		showCustomization?: boolean;
		breadcrumbs: Snippet;
		headerActions?: Snippet;
		topActions?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		{@render breadcrumbs()}
	</nav>

	{#if viewContext}
		<CollectionViewPicker
			context={viewContext}
			path={page.url.pathname}
			query={new URLSearchParams(page.url.search)}
		/>
	{/if}

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
		<div class={`${COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.root} ${COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.stack}`}>
			{@render topActions()}
		</div>
	{/if}

	{@render children?.()}
</section>
