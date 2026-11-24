<script lang="ts">
	import { page } from '$app/state';
	import { selectedCollectionView } from '$lib/collection-view';
	import { useCollectionView } from '$lib/collection-view-context';
	import {
		buildCollectionNavigation,
		handleCollectionSectionShortcut,
		resolveCollectionSection
	} from '$lib/collection-navigation';
	import {
		MEDIA_MODE_QUERY_PARAM,
		MEDIA_PREFERENCE_QUERY_PARAM,
		normalizeMediaMode,
		normalizeMediaPreferenceValue
	} from '$lib/media-mode';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		collectionBiddingNavigationVisibilityForDeployment
	} from '$lib/runtime/public-deployment';
	import CollectionPageLayout from './CollectionPageLayout.svelte';
	import CollectionJumpForm from './CollectionJumpForm.svelte';
	import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from './keyboard-shortcuts-help-controller';
	import { getTokenPreviewController } from './token-preview-controller';

	let {
		tokenId = null,
		onPageKeydown
	}: {
		tokenId?: string | null;
		onPageKeydown?: (event: KeyboardEvent) => void;
	} = $props();
	const collectionView = useCollectionView();
	const context = $derived(collectionView());
	const basePath = $derived(context?.basePath ?? '/');
	const destination = $derived(context?.pickerDestination);
	const query = $derived(new URLSearchParams(destination?.query ?? page.url.search));
	const mediaMode = $derived(normalizeMediaMode(query.get(MEDIA_MODE_QUERY_PARAM)));
	const mediaPreference = $derived(
		normalizeMediaPreferenceValue(query.get(MEDIA_PREFERENCE_QUERY_PARAM))
	);
	const section = $derived(resolveCollectionSection(basePath, destination?.path ?? basePath, query));
	const navigation = $derived(
		buildCollectionNavigation({
			basePath,
			catalogScope: selectedCollectionView(context),
			mediaMode,
			mediaPreference,
			selectedTraits: [],
			selectedTraitRanges: [],
			collectionExtensions: context?.discovery.collection.extensions,
			activityEventFeeds: context?.discovery.collection.activityEventFeeds,
			bidding: collectionBiddingNavigationVisibilityForDeployment()
		})
	);
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const helpState = keyboardShortcutsHelp.state;
	const tokenPreview = getTokenPreviewController();
	const previewState = tokenPreview.state;

	function onWindowKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
		if ($helpState.open) return;
		tokenPreview.onWindowKeydown(event);
		if ($previewState.open) return;
		if (!handleCollectionSectionShortcut(event, navigation)) onPageKeydown?.(event);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if context}
	<CollectionPageLayout
		{navigation}
		{...section}
		activeSection={tokenId ? null : section.activeSection}
		showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
	>
		{#snippet breadcrumbs()}
			{#if !IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={'/' + encodeURIComponent(context.chainRef)}>collections</a>
				<span class="breadcrumbs-separator">/</span>
			{/if}
			{#if tokenId || section.label}
				<a href={navigation.hrefs.asks}>{context.discovery.collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				{#if section.owner}
					<a href={navigation.hrefs.holders}>holders</a>
					<span class="breadcrumbs-separator">/</span>
				{/if}
				<span class="breadcrumbs-current">{tokenId ? '#' + tokenId : section.label}</span>
			{:else}
				<span class="breadcrumbs-current">{context.discovery.collection.slug}</span>
			{/if}
		{/snippet}
		{#snippet headerActions()}
			<CollectionJumpForm chainRef={context.chainRef} {basePath} {mediaMode} {mediaPreference} />
			<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
		{/snippet}
	</CollectionPageLayout>
{/if}
