<script lang="ts">
	import {
		getDefaultBlockExplorerConfig,
		type BlockExplorerConfig
	} from '@artgod/shared/config/block-explorer';
	import {
		COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND,
		type CollectionExtensionNavigationPageTarget
	} from '$lib/collection-extension-navigation';
	import {
		resolveCollectionExtensionPage,
		type CollectionExtensionPageRef
	} from '$lib/collection-extension-pages';
	import { createCollectionExtensionPageActionScope } from '$lib/collection-extension-pages/actions';
	import CollectionExtensionPageOutlet from '$lib/collection-extension-pages/CollectionExtensionPageOutlet.svelte';
	import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';
	import { buildCollectionNavigation } from '$lib/collection-navigation';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import {
		collectionBiddingNavigationVisibilityForDeployment,
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';

	let {
		chain,
		collection,
		media,
		basePath,
		page,
		blockExplorer = getDefaultBlockExplorerConfig()
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		media: ApiCollectionMediaState;
		basePath: string;
		page: CollectionExtensionPageRef;
		blockExplorer?: BlockExplorerConfig;
	} = $props();

	const resolvedPage = $derived(resolveCollectionExtensionPage(page));
	const extensionPageActions = createCollectionExtensionPageActionScope();
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const activeExtensionPage = $derived({
		kind: COLLECTION_EXTENSION_NAVIGATION_TAB_TARGET_KIND.ExtensionPage,
		extensionKey: page.extensionKey,
		pageRef: page.pageRef
	} satisfies CollectionExtensionNavigationPageTarget);

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath,
			mediaMode: media.selectedMode,
			mediaPreference: media.preference,
			selectedTraits: [],
			selectedTraitRanges: [],
			activityEventFeeds: collection?.activityEventFeeds ?? [],
			collectionExtensions: collection?.extensions ?? [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment()
			}
		});
	}

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function collectionHref(): string {
		return collectionNavigation().hrefs.asks;
	}

	function pageLabel(): string {
		return resolvedPage?.label ?? page.pageRef;
	}
</script>

{#snippet extensionHeaderActions()}
	{#if collection}
		<CollectionJumpForm
			chainRef={chain?.slug ?? ''}
			{basePath}
			mediaMode={media.selectedMode}
			mediaPreference={media.preference}
		/>
	{/if}
	<KeyboardShortcutsHelp {keyboardShortcutsHelp} {blockExplorer} />
{/snippet}

{#snippet extensionTopActions()}
	{#if chain && collection && resolvedPage?.TopActions}
		<CollectionExtensionPageOutlet
			Page={resolvedPage.TopActions}
			{chain}
			{collection}
			{media}
			{basePath}
			{page}
			actions={extensionPageActions}
		/>
	{/if}
{/snippet}

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="extension-page"
	{activeExtensionPage}
	collectionAvailable={chain !== null && collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
	headerActions={extensionHeaderActions}
	topActions={resolvedPage?.TopActions ? extensionTopActions : undefined}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={collectionHref()}>{collection.slug}</a>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionHref()}>{collection.slug}</a>
			{/if}
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">{pageLabel()}</span>
		{/if}
	{/snippet}

	{#if chain && collection && resolvedPage}
		<CollectionExtensionPageOutlet
			Page={resolvedPage.Page}
			{chain}
			{collection}
			{media}
			{basePath}
			{page}
			actions={extensionPageActions}
		/>
	{:else if chain && collection}
		<p class="muted">extension page not found</p>
	{/if}
</CollectionPageLayout>
