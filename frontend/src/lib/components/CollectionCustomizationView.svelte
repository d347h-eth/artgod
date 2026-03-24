<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionCustomizationSource,
		ApiTokenAttribute,
		ApiTraitFilterDisplayKind,
		ApiTraitRangeFilter,
		CollectionCustomizationApiResponse
	} from '$lib/api-types';
	import { updateCollectionCustomization } from '$lib/backend-api';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { buildCollectionCustomizationHref } from '$lib/customization-query';
	import { appendMediaModeParam } from '$lib/media-mode';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';

	type TraitFilterPresentationState =
		CollectionCustomizationApiResponse['customization']['traitFilterPresentation'];

	let {
		chain,
		collection,
		customization,
		basePath,
		selectedTraits,
		selectedTraitRanges,
		mediaMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		customization: CollectionCustomizationApiResponse['customization'] | null;
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		mediaMode: string | null;
	} = $props();

	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	let traitFilterPresentation = $state<TraitFilterPresentationState>(fallbackTraitFilterPresentationState());
	let saving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);

	$effect(() => {
		traitFilterPresentation =
			customization?.traitFilterPresentation ?? fallbackTraitFilterPresentationState();
		saveMessage = null;
		saveError = null;
	});

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function tokensHref(): string {
		return buildTokenBrowserHref({
			basePath,
			limit: DEFAULT_PAGE_LIMIT,
			displayMode: 'grid',
			tokenStatus: 'listed',
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function activitiesHref(): string {
		return buildCollectionActivityHref({
			basePath,
			limit: DEFAULT_PAGE_LIMIT,
			kind: 'sales',
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function holdersHref(): string {
		const query = new URLSearchParams();
		appendMediaModeParam(query, mediaMode);
		const suffix = query.toString();
		return `${basePath}/holders${suffix ? `?${suffix}` : ''}`;
	}

	function customizationHref(): string {
		return buildCollectionCustomizationHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function fallbackTraitFilterPresentationState(): TraitFilterPresentationState {
		return {
			selectedSource: 'user',
			userConfig: { rangeKeys: [] },
			extensionConfig: null,
			effectiveConfig: { rangeKeys: [] },
			availableTraitKeys: []
		};
	}

	function displayKindForConfig(
		rangeKeys: string[],
		key: string
	): ApiTraitFilterDisplayKind {
		return rangeKeys.includes(key) ? 'range' : 'set';
	}

	function sourceButtonLabel(source: ApiCollectionCustomizationSource): string {
		return source === 'user' ? 'user-defined' : 'extension-defined';
	}

	function extensionDisplayKindValue(key: string): ApiTraitFilterDisplayKind | '' {
		if (traitFilterPresentation.extensionConfig === null) {
			return '';
		}
		return displayKindForConfig(traitFilterPresentation.extensionConfig.rangeKeys, key);
	}

	function extensionSourceAvailable(): boolean {
		return traitFilterPresentation.extensionConfig !== null;
	}

	function selectedSource(): ApiCollectionCustomizationSource {
		if (
			traitFilterPresentation.selectedSource === 'extension' &&
			traitFilterPresentation.extensionConfig === null
		) {
			return 'user';
		}
		return traitFilterPresentation.selectedSource;
	}

	function setSelectedSource(nextSource: ApiCollectionCustomizationSource): void {
		if (nextSource === 'extension' && !extensionSourceAvailable()) {
			return;
		}
		traitFilterPresentation = {
			...traitFilterPresentation,
			selectedSource: nextSource
		};
	}

	function onUserDisplayKindChange(key: string, nextKind: ApiTraitFilterDisplayKind): void {
		const nextRangeKeys = new Set(traitFilterPresentation.userConfig.rangeKeys);
		if (nextKind === 'range') {
			nextRangeKeys.add(key);
		} else {
			nextRangeKeys.delete(key);
		}
		traitFilterPresentation = {
			...traitFilterPresentation,
			userConfig: {
				rangeKeys: [...nextRangeKeys].sort((left, right) => left.localeCompare(right))
			}
		};
	}

	async function onSave(): Promise<void> {
		if (!chain || !collection || saving) return;
		saving = true;
		saveMessage = null;
		saveError = null;

		try {
			const response = await updateCollectionCustomization(fetch, chain.slug, collection.slug, {
				traitFilterPresentation: {
					selectedSource: selectedSource(),
					userConfig: {
						rangeKeys: traitFilterPresentation.userConfig.rangeKeys
					}
				}
			});
			traitFilterPresentation = response.customization.traitFilterPresentation;
			saveMessage = 'saved';
		} catch (error) {
			saveError =
				error instanceof Error ? error.message : 'failed to update collection customization';
		} finally {
			saving = false;
		}
	}
</script>

<CollectionPageLayout
	tokensHref={tokensHref()}
	activitiesHref={activitiesHref()}
	holdersHref={holdersHref()}
	customizationHref={customizationHref()}
	activeSection="customization"
	collectionAvailable={collection !== null}
>
	{#snippet breadcrumbs()}
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<a href={tokensHref()}>{collection.slug}</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">customization</span>
		{/if}
	{/snippet}
	{#snippet headerActions()}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}

	<section class="customization-panel">
		<header class="panel-header">
			<div>
				<h2 class="customization-title">trait filter presentation</h2>
				<p class="muted">configure which trait keys use discrete sets or inclusive ranges</p>
			</div>
		</header>

		<div class="customization-section">
			<h3 class="customization-section-title">active source</h3>
			<div class="secondary-tabs" aria-label="Trait filter presentation source">
				{#if selectedSource() === 'user'}
					<span class="secondary-tab-active">{sourceButtonLabel('user')}</span>
				{:else}
					<button type="button" onclick={() => setSelectedSource('user')}>
						{sourceButtonLabel('user')}
					</button>
				{/if}
				{#if extensionSourceAvailable()}
					{#if selectedSource() === 'extension'}
						<span class="secondary-tab-active">{sourceButtonLabel('extension')}</span>
					{:else}
						<button type="button" onclick={() => setSelectedSource('extension')}>
							{sourceButtonLabel('extension')}
						</button>
					{/if}
				{:else}
					<span class="secondary-tab-disabled">{sourceButtonLabel('extension')}</span>
				{/if}
			</div>
			{#if !extensionSourceAvailable()}
				<p class="muted">no extension override available for this feature</p>
			{/if}
		</div>

		<div class="customization-grid-wrap">
			{#if traitFilterPresentation.availableTraitKeys.length === 0}
				<p class="muted">no trait keys available yet</p>
			{:else}
				<div class="customization-grid">
					<div class="customization-grid-header mono">trait</div>
					<div class="customization-grid-header">user-defined</div>
					<div class="customization-grid-header">extension-defined</div>

					{#each traitFilterPresentation.availableTraitKeys as key}
						<div class="mono customization-trait-key">{key}</div>
						<select
							class="customization-select"
							value={displayKindForConfig(traitFilterPresentation.userConfig.rangeKeys, key)}
							onchange={(event) => {
								const target = event.currentTarget;
								if (!(target instanceof HTMLSelectElement)) return;
								onUserDisplayKindChange(
									key,
									target.value === 'range' ? 'range' : 'set'
								);
							}}
						>
							<option value="set">set</option>
							<option value="range">range</option>
						</select>
						<select
							class="customization-select"
							value={extensionDisplayKindValue(key)}
							disabled
						>
							<option value="">-</option>
							<option value="set">set</option>
							<option value="range">range</option>
						</select>
					{/each}
				</div>
			{/if}
		</div>

		<footer class="panel-footer customization-footer">
			<span class="muted">
				effective source: <span class="mono">{sourceButtonLabel(selectedSource())}</span>
			</span>
			{#if saveMessage}
				<span class="muted">{saveMessage}</span>
			{/if}
			{#if saveError}
				<span class="muted">{saveError}</span>
			{/if}
			<button
				type="button"
				class="button-link"
				disabled={saving}
				aria-busy={saving}
				onclick={() => void onSave()}
			>
				save
			</button>
		</footer>
	</section>
</CollectionPageLayout>
