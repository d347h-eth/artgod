<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import {
		BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
	} from '@artgod/shared/config/bootstrap';
	import {
		COLLECTION_MEDIA_SOURCE,
		defaultMediaPurposePolicyConfig
	} from '@artgod/shared/types';
	import { IMAGE_CACHE_MODE, imageCacheModeLabel } from '@artgod/shared/media/token-image-cache';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaSource,
		ApiCollectionCustomizationSource,
		ApiImageCacheMode,
		ApiTokenAttribute,
		ApiTraitFilterDisplayKind,
		ApiTraitRangeFilter,
		CollectionCustomizationApiResponse
	} from '$lib/api-types';
	import { updateCollectionCustomization } from '$lib/backend-api';
	import {
		buildCollectionNavigation,
		handleCollectionSectionShortcut
	} from '$lib/collection-navigation';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import {
		collectionBiddingNavigationVisibilityForDeployment,
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';

	type TraitFilterPresentationState =
		CollectionCustomizationApiResponse['customization']['traitFilterPresentation'];
	type TraitSummaryTemplateState =
		CollectionCustomizationApiResponse['customization']['tokenCardTraitSummaryTemplate'];
	type ImageCachePolicyState =
		CollectionCustomizationApiResponse['customization']['imageCachePolicy'];
	type MediaPurposePolicyState =
		CollectionCustomizationApiResponse['customization']['mediaPurposePolicy'];

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
	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;
	let traitFilterPresentation = $state<TraitFilterPresentationState>(
		customization?.traitFilterPresentation ?? fallbackTraitFilterPresentationState()
	);
	let tokenCardTraitSummaryTemplate = $state<TraitSummaryTemplateState>(
		customization?.tokenCardTraitSummaryTemplate ?? fallbackTraitSummaryTemplateState()
	);
	let activityRowTraitSummaryTemplate = $state<TraitSummaryTemplateState>(
		customization?.activityRowTraitSummaryTemplate ?? fallbackTraitSummaryTemplateState()
	);
	let imageCachePolicy = $state<ImageCachePolicyState>(
		customization?.imageCachePolicy ?? fallbackImageCachePolicyState()
	);
	let mediaPurposePolicy = $state<MediaPurposePolicyState>(
		customization?.mediaPurposePolicy ?? fallbackMediaPurposePolicyState()
	);
	let traitFilterSaving = $state(false);
	let traitFilterSaveMessage = $state<string | null>(null);
	let traitFilterSaveError = $state<string | null>(null);
	let tokenCardSaving = $state(false);
	let tokenCardSaveMessage = $state<string | null>(null);
	let tokenCardSaveError = $state<string | null>(null);
	let activityRowSaving = $state(false);
	let activityRowSaveMessage = $state<string | null>(null);
	let activityRowSaveError = $state<string | null>(null);
	let imageCachePolicySaving = $state(false);
	let imageCachePolicySaveMessage = $state<string | null>(null);
	let imageCachePolicySaveError = $state<string | null>(null);
	let mediaPurposePolicySaving = $state(false);
	let mediaPurposePolicySaveMessage = $state<string | null>(null);
	let mediaPurposePolicySaveError = $state<string | null>(null);

	$effect(() => {
		traitFilterPresentation =
			customization?.traitFilterPresentation ?? fallbackTraitFilterPresentationState();
		tokenCardTraitSummaryTemplate =
			customization?.tokenCardTraitSummaryTemplate ?? fallbackTraitSummaryTemplateState();
		activityRowTraitSummaryTemplate =
			customization?.activityRowTraitSummaryTemplate ?? fallbackTraitSummaryTemplateState();
		imageCachePolicy = customization?.imageCachePolicy ?? fallbackImageCachePolicyState();
		mediaPurposePolicy = customization?.mediaPurposePolicy ?? fallbackMediaPurposePolicyState();
		resetSaveState();
	});

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath,
			mediaMode,
			selectedTraits,
			selectedTraitRanges,
			token: {
				limit: DEFAULT_PAGE_LIMIT,
				displayMode: 'grid'
			},
			activity: {
				limit: DEFAULT_PAGE_LIMIT,
				kind: 'sales'
			},
			activityEventFeeds: collection?.activityEventFeeds ?? [],
			collectionExtensions: collection?.extensions ?? [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment()
			}
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

	function fallbackTraitSummaryTemplateState(): TraitSummaryTemplateState {
		return {
			selectedSource: 'user',
			userConfig: { template: '' },
			extensionConfig: null,
			effectiveConfig: { template: '' }
		};
	}

	function fallbackImageCachePolicyState(): ImageCachePolicyState {
		return {
			selectedSource: 'user',
			userConfig: {
				imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION
			},
			extensionConfig: null,
			effectiveConfig: {
				imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION
			}
		};
	}

	function fallbackMediaPurposePolicyState(): MediaPurposePolicyState {
		const defaultConfig = defaultMediaPurposePolicyConfig();
		return {
			selectedSource: 'user',
			userConfig: defaultConfig,
			extensionConfig: null,
			effectiveConfig: defaultConfig
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

	function imageCacheMaxDimensionLabel(value: number | null): string {
		return value === null ? 'original' : String(value);
	}

	function imageCacheMaxDimensionInputValue(value: number | null): string {
		return value === null ? '' : String(value);
	}

	function mediaSourceLabel(source: ApiCollectionMediaSource): string {
		return source;
	}

	function extensionDisplayKindValue(key: string): ApiTraitFilterDisplayKind | '' {
		if (traitFilterPresentation.extensionConfig === null) {
			return '';
		}
		return displayKindForConfig(traitFilterPresentation.extensionConfig.rangeKeys, key);
	}

	function extensionSourceAvailable<T extends { extensionConfig: unknown | null }>(feature: T): boolean {
		return feature.extensionConfig !== null;
	}

	function selectedSource<T extends { selectedSource: ApiCollectionCustomizationSource; extensionConfig: unknown | null }>(
		feature: T
	): ApiCollectionCustomizationSource {
		if (
			feature.selectedSource === 'extension' &&
			feature.extensionConfig === null
		) {
			return 'user';
		}
		return feature.selectedSource;
	}

	function setTraitFilterSelectedSource(nextSource: ApiCollectionCustomizationSource): void {
		if (nextSource === 'extension' && !extensionSourceAvailable(traitFilterPresentation)) {
			return;
		}
		traitFilterPresentation = {
			...traitFilterPresentation,
			selectedSource: nextSource
		};
	}

	function setTemplateFeatureSelectedSource(
		feature: 'tokenCard' | 'activityRow',
		nextSource: ApiCollectionCustomizationSource
	): void {
		const current =
			feature === 'tokenCard' ? tokenCardTraitSummaryTemplate : activityRowTraitSummaryTemplate;
		if (nextSource === 'extension' && !extensionSourceAvailable(current)) {
			return;
		}
		if (feature === 'tokenCard') {
			tokenCardTraitSummaryTemplate = {
				...tokenCardTraitSummaryTemplate,
				selectedSource: nextSource
			};
			return;
		}
		activityRowTraitSummaryTemplate = {
			...activityRowTraitSummaryTemplate,
			selectedSource: nextSource
		};
	}

	function setImageCachePolicySelectedSource(nextSource: ApiCollectionCustomizationSource): void {
		if (nextSource === 'extension' && !extensionSourceAvailable(imageCachePolicy)) {
			return;
		}
		imageCachePolicy = {
			...imageCachePolicy,
			selectedSource: nextSource
		};
	}

	function setMediaPurposePolicySelectedSource(nextSource: ApiCollectionCustomizationSource): void {
		if (nextSource === 'extension' && !extensionSourceAvailable(mediaPurposePolicy)) {
			return;
		}
		mediaPurposePolicy = {
			...mediaPurposePolicy,
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

	function onTemplateInput(feature: 'tokenCard' | 'activityRow', event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLTextAreaElement)) return;
		if (feature === 'tokenCard') {
			tokenCardTraitSummaryTemplate = {
				...tokenCardTraitSummaryTemplate,
				userConfig: {
					template: target.value
				}
			};
			return;
		}
		activityRowTraitSummaryTemplate = {
			...activityRowTraitSummaryTemplate,
			userConfig: {
				template: target.value
			}
		};
	}

	function onImageCacheModeChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		const nextMode = parseImageCacheMode(target.value);
		imageCachePolicy = {
			...imageCachePolicy,
			userConfig: {
				imageCacheMode: nextMode,
				maxDimension:
					nextMode === IMAGE_CACHE_MODE.Off
						? null
						: (imageCachePolicy.userConfig.maxDimension ??
							BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION)
			}
		};
	}

	function onImageCacheMaxDimensionInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		const raw = target.value.trim();
		if (!raw) {
			imageCachePolicy = {
				...imageCachePolicy,
				userConfig: {
					...imageCachePolicy.userConfig,
					maxDimension: null
				}
			};
			return;
		}
		const parsed = Number(raw);
		if (
			!Number.isInteger(parsed) ||
			parsed < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
			parsed > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION
		) {
			imageCachePolicySaveError = `image max dimension must be ${BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}-${BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION}`;
			return;
		}
		imageCachePolicySaveError = null;
		imageCachePolicy = {
			...imageCachePolicy,
			userConfig: {
				...imageCachePolicy.userConfig,
				maxDimension: parsed
			}
		};
	}

	function readMediaPurposeSourceFromSelect(event: Event): ApiCollectionMediaSource | null {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return null;
		return target.value === COLLECTION_MEDIA_SOURCE.AnimationUrl
			? COLLECTION_MEDIA_SOURCE.AnimationUrl
			: COLLECTION_MEDIA_SOURCE.Image;
	}

	function onTokenCardMediaPurposeSourceChange(event: Event): void {
		const nextSource = readMediaPurposeSourceFromSelect(event);
		if (!nextSource) return;
		mediaPurposePolicy = {
			...mediaPurposePolicy,
			userConfig: {
				...mediaPurposePolicy.userConfig,
				tokenCard: nextSource
			}
		};
	}

	function onFullscreenPreviewMediaPurposeSourceChange(event: Event): void {
		const nextSource = readMediaPurposeSourceFromSelect(event);
		if (!nextSource) return;
		mediaPurposePolicy = {
			...mediaPurposePolicy,
			userConfig: {
				...mediaPurposePolicy.userConfig,
				fullscreenPreview: nextSource
			}
		};
	}

	function onTokenDetailMediaPurposeSourceChange(event: Event): void {
		const nextSource = readMediaPurposeSourceFromSelect(event);
		if (!nextSource) return;
		mediaPurposePolicy = {
			...mediaPurposePolicy,
			userConfig: {
				...mediaPurposePolicy.userConfig,
				tokenDetail: nextSource
			}
		};
	}

	function parseImageCacheMode(value: string): ApiImageCacheMode {
		if (
			value === IMAGE_CACHE_MODE.Off ||
			value === IMAGE_CACHE_MODE.CacheOnce ||
			value === IMAGE_CACHE_MODE.RefreshOnMetadata
		) {
			return value;
		}
		return IMAGE_CACHE_MODE.CacheOnce;
	}

	function applyCustomizationState(
		nextCustomization: CollectionCustomizationApiResponse['customization']
	): void {
		traitFilterPresentation = nextCustomization.traitFilterPresentation;
		tokenCardTraitSummaryTemplate = nextCustomization.tokenCardTraitSummaryTemplate;
		activityRowTraitSummaryTemplate = nextCustomization.activityRowTraitSummaryTemplate;
		imageCachePolicy = nextCustomization.imageCachePolicy;
		mediaPurposePolicy = nextCustomization.mediaPurposePolicy;
	}

	function buildCustomizationBody() {
		return {
			traitFilterPresentation: {
				selectedSource: selectedSource(traitFilterPresentation),
				userConfig: {
					rangeKeys: traitFilterPresentation.userConfig.rangeKeys
				}
			},
			tokenCardTraitSummaryTemplate: {
				selectedSource: selectedSource(tokenCardTraitSummaryTemplate),
				userConfig: {
					template: tokenCardTraitSummaryTemplate.userConfig.template
				}
			},
			activityRowTraitSummaryTemplate: {
				selectedSource: selectedSource(activityRowTraitSummaryTemplate),
				userConfig: {
					template: activityRowTraitSummaryTemplate.userConfig.template
				}
			},
			imageCachePolicy: {
				selectedSource: selectedSource(imageCachePolicy),
				userConfig: {
					imageCacheMode: imageCachePolicy.userConfig.imageCacheMode,
					maxDimension:
						imageCachePolicy.userConfig.imageCacheMode === IMAGE_CACHE_MODE.Off
							? null
							: imageCachePolicy.userConfig.maxDimension
				}
			},
			mediaPurposePolicy: {
				selectedSource: selectedSource(mediaPurposePolicy),
				userConfig: {
					tokenCard: mediaPurposePolicy.userConfig.tokenCard,
					fullscreenPreview: mediaPurposePolicy.userConfig.fullscreenPreview,
					tokenDetail: mediaPurposePolicy.userConfig.tokenDetail
				}
			}
		};
	}

	function resetSaveState(): void {
		traitFilterSaveMessage = null;
		traitFilterSaveError = null;
		tokenCardSaveMessage = null;
		tokenCardSaveError = null;
		activityRowSaveMessage = null;
		activityRowSaveError = null;
		imageCachePolicySaveMessage = null;
		imageCachePolicySaveError = null;
		mediaPurposePolicySaveMessage = null;
		mediaPurposePolicySaveError = null;
	}

	async function onSave(
		feature:
			| 'traitFilter'
			| 'tokenCard'
			| 'activityRow'
			| 'imageCachePolicy'
			| 'mediaPurposePolicy'
	): Promise<void> {
		if (!chain || !collection) return;
		if (
			(feature === 'traitFilter' && traitFilterSaving) ||
			(feature === 'tokenCard' && tokenCardSaving) ||
			(feature === 'activityRow' && activityRowSaving) ||
			(feature === 'imageCachePolicy' && imageCachePolicySaving) ||
			(feature === 'mediaPurposePolicy' && mediaPurposePolicySaving)
		) {
			return;
		}

		if (feature === 'traitFilter') {
			traitFilterSaving = true;
			traitFilterSaveMessage = null;
			traitFilterSaveError = null;
		} else if (feature === 'tokenCard') {
			tokenCardSaving = true;
			tokenCardSaveMessage = null;
			tokenCardSaveError = null;
		} else if (feature === 'activityRow') {
			activityRowSaving = true;
			activityRowSaveMessage = null;
			activityRowSaveError = null;
		} else if (feature === 'imageCachePolicy') {
			imageCachePolicySaving = true;
			imageCachePolicySaveMessage = null;
			imageCachePolicySaveError = null;
		} else {
			mediaPurposePolicySaving = true;
			mediaPurposePolicySaveMessage = null;
			mediaPurposePolicySaveError = null;
		}

		try {
			const response = await updateCollectionCustomization(
				fetch,
				chain.slug,
				collection.slug,
				buildCustomizationBody()
			);
			applyCustomizationState(response.customization);
			if (feature === 'traitFilter') {
				traitFilterSaveMessage = 'saved';
			} else if (feature === 'tokenCard') {
				tokenCardSaveMessage = 'saved';
			} else if (feature === 'activityRow') {
				activityRowSaveMessage = 'saved';
			} else if (feature === 'imageCachePolicy') {
				imageCachePolicySaveMessage = 'saved';
			} else {
				mediaPurposePolicySaveMessage = 'saved';
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'failed to update collection customization';
			if (feature === 'traitFilter') {
				traitFilterSaveError = message;
			} else if (feature === 'tokenCard') {
				tokenCardSaveError = message;
			} else if (feature === 'activityRow') {
				activityRowSaveError = message;
			} else if (feature === 'imageCachePolicy') {
				imageCachePolicySaveError = message;
			} else {
				mediaPurposePolicySaveError = message;
			}
		} finally {
			if (feature === 'traitFilter') {
				traitFilterSaving = false;
			} else if (feature === 'tokenCard') {
				tokenCardSaving = false;
			} else if (feature === 'activityRow') {
				activityRowSaving = false;
			} else if (feature === 'imageCachePolicy') {
				imageCachePolicySaving = false;
			} else {
				mediaPurposePolicySaving = false;
			}
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
		if (event.defaultPrevented || $keyboardShortcutsHelpState.open) return;
		handleCollectionSectionShortcut(event, collectionNavigation());
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="customization"
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">customization</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">customization</span>
			{/if}
		{/if}
	{/snippet}
	{#snippet headerActions()}
		{#if collection}
			<CollectionJumpForm chainRef={chain?.slug ?? ''} basePath={basePath} mediaMode={mediaMode} />
		{/if}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}

	<section class="customization-panel">
		<section class="customization-feature-panel">
			<header class="panel-header">
				<div>
					<h2 class="customization-title">trait filter presentation</h2>
					<p class="muted">configure which trait keys use discrete sets or inclusive ranges</p>
				</div>
			</header>

			<div class="customization-section">
				<h3 class="customization-section-title">active source</h3>
				<div class="secondary-tabs" aria-label="Trait filter presentation source">
					{#if selectedSource(traitFilterPresentation) === 'user'}
						<span class="secondary-tab-active">{sourceButtonLabel('user')}</span>
					{:else}
						<button type="button" onclick={() => setTraitFilterSelectedSource('user')}>
							{sourceButtonLabel('user')}
						</button>
					{/if}
					{#if extensionSourceAvailable(traitFilterPresentation)}
						{#if selectedSource(traitFilterPresentation) === 'extension'}
							<span class="secondary-tab-active">{sourceButtonLabel('extension')}</span>
						{:else}
							<button type="button" onclick={() => setTraitFilterSelectedSource('extension')}>
								{sourceButtonLabel('extension')}
							</button>
						{/if}
					{:else}
						<span class="secondary-tab-disabled">{sourceButtonLabel('extension')}</span>
					{/if}
				</div>
				{#if !extensionSourceAvailable(traitFilterPresentation)}
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
					effective source:
					<span class="mono">{sourceButtonLabel(selectedSource(traitFilterPresentation))}</span>
				</span>
				{#if traitFilterSaveMessage}
					<span class="muted">{traitFilterSaveMessage}</span>
				{/if}
				{#if traitFilterSaveError}
					<span class="muted">{traitFilterSaveError}</span>
				{/if}
				<button
					type="button"
					class="button-link"
					disabled={traitFilterSaving}
					aria-busy={traitFilterSaving}
					onclick={() => void onSave('traitFilter')}
				>
					save
				</button>
			</footer>
		</section>

		<section class="customization-feature-panel">
			<header class="panel-header">
				<div>
					<h2 class="customization-title">image cache policy</h2>
				</div>
			</header>

			<div class="customization-section">
				<h3 class="customization-section-title">active source</h3>
				<div class="secondary-tabs" aria-label="Image cache policy source">
					{#if selectedSource(imageCachePolicy) === 'user'}
						<span class="secondary-tab-active">{sourceButtonLabel('user')}</span>
					{:else}
						<button type="button" onclick={() => setImageCachePolicySelectedSource('user')}>
							{sourceButtonLabel('user')}
						</button>
					{/if}
					{#if extensionSourceAvailable(imageCachePolicy)}
						{#if selectedSource(imageCachePolicy) === 'extension'}
							<span class="secondary-tab-active">{sourceButtonLabel('extension')}</span>
						{:else}
							<button type="button" onclick={() => setImageCachePolicySelectedSource('extension')}>
								{sourceButtonLabel('extension')}
							</button>
						{/if}
					{:else}
						<span class="secondary-tab-disabled">{sourceButtonLabel('extension')}</span>
					{/if}
				</div>
				{#if !extensionSourceAvailable(imageCachePolicy)}
					<p class="muted">no extension override available for this feature</p>
				{/if}
			</div>

			<div class="customization-grid-wrap">
				<div class="customization-grid">
					<div class="customization-grid-header mono">field</div>
					<div class="customization-grid-header">user-defined</div>
					<div class="customization-grid-header">extension-defined</div>

					<div class="mono customization-trait-key">mode</div>
					<select
						class="customization-select"
						value={imageCachePolicy.userConfig.imageCacheMode}
						onchange={onImageCacheModeChange}
					>
						<option value={IMAGE_CACHE_MODE.Off}>
							{imageCacheModeLabel(IMAGE_CACHE_MODE.Off)}
						</option>
						<option value={IMAGE_CACHE_MODE.CacheOnce}>
							{imageCacheModeLabel(IMAGE_CACHE_MODE.CacheOnce)}
						</option>
						<option value={IMAGE_CACHE_MODE.RefreshOnMetadata}>
							{imageCacheModeLabel(IMAGE_CACHE_MODE.RefreshOnMetadata)}
						</option>
					</select>
					<input
						class="customization-readonly-input"
						type="text"
						value={imageCachePolicy.extensionConfig
							? imageCacheModeLabel(imageCachePolicy.extensionConfig.imageCacheMode)
							: ''}
						placeholder="not available"
						readonly
					/>

					<div class="mono customization-trait-key">max dimension</div>
					<input
						class="customization-text-input"
						type="number"
						min={BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}
						max={BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION}
						value={imageCacheMaxDimensionInputValue(imageCachePolicy.userConfig.maxDimension)}
						disabled={imageCachePolicy.userConfig.imageCacheMode === IMAGE_CACHE_MODE.Off}
						oninput={onImageCacheMaxDimensionInput}
					/>
					<input
						class="customization-readonly-input"
						type="text"
						value={imageCachePolicy.extensionConfig
							? imageCacheMaxDimensionLabel(imageCachePolicy.extensionConfig.maxDimension)
							: ''}
						placeholder="not available"
						readonly
					/>
				</div>
			</div>

			<footer class="panel-footer customization-footer">
				<span class="muted">
					effective source:
					<span class="mono">{sourceButtonLabel(selectedSource(imageCachePolicy))}</span>
				</span>
				{#if imageCachePolicySaveMessage}
					<span class="muted">{imageCachePolicySaveMessage}</span>
				{/if}
				{#if imageCachePolicySaveError}
					<span class="muted">{imageCachePolicySaveError}</span>
				{/if}
				<button
					type="button"
					class="button-link"
					disabled={imageCachePolicySaving}
					aria-busy={imageCachePolicySaving}
					onclick={() => void onSave('imageCachePolicy')}
				>
					save
				</button>
			</footer>
		</section>

		<section class="customization-feature-panel">
			<header class="panel-header">
				<div>
					<h2 class="customization-title">media purpose policy</h2>
				</div>
			</header>

			<div class="customization-section">
				<h3 class="customization-section-title">active source</h3>
				<div class="secondary-tabs" aria-label="Media purpose policy source">
					{#if selectedSource(mediaPurposePolicy) === 'user'}
						<span class="secondary-tab-active">{sourceButtonLabel('user')}</span>
					{:else}
						<button type="button" onclick={() => setMediaPurposePolicySelectedSource('user')}>
							{sourceButtonLabel('user')}
						</button>
					{/if}
					{#if extensionSourceAvailable(mediaPurposePolicy)}
						{#if selectedSource(mediaPurposePolicy) === 'extension'}
							<span class="secondary-tab-active">{sourceButtonLabel('extension')}</span>
						{:else}
							<button type="button" onclick={() => setMediaPurposePolicySelectedSource('extension')}>
								{sourceButtonLabel('extension')}
							</button>
						{/if}
					{:else}
						<span class="secondary-tab-disabled">{sourceButtonLabel('extension')}</span>
					{/if}
				</div>
				{#if !extensionSourceAvailable(mediaPurposePolicy)}
					<p class="muted">no extension override available for this feature</p>
				{/if}
			</div>

			<div class="customization-grid-wrap">
				<div class="customization-grid">
					<div class="customization-grid-header mono">purpose</div>
					<div class="customization-grid-header">user-defined</div>
					<div class="customization-grid-header">extension-defined</div>

					<div class="mono customization-trait-key">token card</div>
					<select
						class="customization-select"
						value={mediaPurposePolicy.userConfig.tokenCard}
						onchange={onTokenCardMediaPurposeSourceChange}
					>
						<option value={COLLECTION_MEDIA_SOURCE.Image}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.Image)}
						</option>
						<option value={COLLECTION_MEDIA_SOURCE.AnimationUrl}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.AnimationUrl)}
						</option>
					</select>
					<select
						class="customization-select"
						value={mediaPurposePolicy.extensionConfig?.tokenCard ?? ''}
						disabled
					>
						<option value="">not available</option>
						<option value={COLLECTION_MEDIA_SOURCE.Image}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.Image)}
						</option>
						<option value={COLLECTION_MEDIA_SOURCE.AnimationUrl}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.AnimationUrl)}
						</option>
					</select>

					<div class="mono customization-trait-key">fullscreen preview</div>
					<select
						class="customization-select"
						value={mediaPurposePolicy.userConfig.fullscreenPreview}
						onchange={onFullscreenPreviewMediaPurposeSourceChange}
					>
						<option value={COLLECTION_MEDIA_SOURCE.Image}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.Image)}
						</option>
						<option value={COLLECTION_MEDIA_SOURCE.AnimationUrl}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.AnimationUrl)}
						</option>
					</select>
					<select
						class="customization-select"
						value={mediaPurposePolicy.extensionConfig?.fullscreenPreview ?? ''}
						disabled
					>
						<option value="">not available</option>
						<option value={COLLECTION_MEDIA_SOURCE.Image}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.Image)}
						</option>
						<option value={COLLECTION_MEDIA_SOURCE.AnimationUrl}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.AnimationUrl)}
						</option>
					</select>

					<div class="mono customization-trait-key">token detail</div>
					<select
						class="customization-select"
						value={mediaPurposePolicy.userConfig.tokenDetail}
						onchange={onTokenDetailMediaPurposeSourceChange}
					>
						<option value={COLLECTION_MEDIA_SOURCE.Image}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.Image)}
						</option>
						<option value={COLLECTION_MEDIA_SOURCE.AnimationUrl}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.AnimationUrl)}
						</option>
					</select>
					<select
						class="customization-select"
						value={mediaPurposePolicy.extensionConfig?.tokenDetail ?? ''}
						disabled
					>
						<option value="">not available</option>
						<option value={COLLECTION_MEDIA_SOURCE.Image}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.Image)}
						</option>
						<option value={COLLECTION_MEDIA_SOURCE.AnimationUrl}>
							{mediaSourceLabel(COLLECTION_MEDIA_SOURCE.AnimationUrl)}
						</option>
					</select>
				</div>
			</div>

			<footer class="panel-footer customization-footer">
				<span class="muted">
					effective source:
					<span class="mono">{sourceButtonLabel(selectedSource(mediaPurposePolicy))}</span>
				</span>
				{#if mediaPurposePolicySaveMessage}
					<span class="muted">{mediaPurposePolicySaveMessage}</span>
				{/if}
				{#if mediaPurposePolicySaveError}
					<span class="muted">{mediaPurposePolicySaveError}</span>
				{/if}
				<button
					type="button"
					class="button-link"
					disabled={mediaPurposePolicySaving}
					aria-busy={mediaPurposePolicySaving}
					onclick={() => void onSave('mediaPurposePolicy')}
				>
					save
				</button>
			</footer>
		</section>

		<section class="customization-feature-panel">
			<header class="panel-header">
				<div>
					<h2 class="customization-title">token card trait summary template</h2>
					<p class="muted">render compact token-card trait text from one template string</p>
				</div>
			</header>

			<div class="customization-section">
				<h3 class="customization-section-title">active source</h3>
				<div class="secondary-tabs" aria-label="Token card trait summary source">
					{#if selectedSource(tokenCardTraitSummaryTemplate) === 'user'}
						<span class="secondary-tab-active">{sourceButtonLabel('user')}</span>
					{:else}
						<button type="button" onclick={() => setTemplateFeatureSelectedSource('tokenCard', 'user')}>
							{sourceButtonLabel('user')}
						</button>
					{/if}
					{#if extensionSourceAvailable(tokenCardTraitSummaryTemplate)}
						{#if selectedSource(tokenCardTraitSummaryTemplate) === 'extension'}
							<span class="secondary-tab-active">{sourceButtonLabel('extension')}</span>
						{:else}
							<button
								type="button"
								onclick={() => setTemplateFeatureSelectedSource('tokenCard', 'extension')}
							>
								{sourceButtonLabel('extension')}
							</button>
						{/if}
					{:else}
						<span class="secondary-tab-disabled">{sourceButtonLabel('extension')}</span>
					{/if}
				</div>
				{#if !extensionSourceAvailable(tokenCardTraitSummaryTemplate)}
					<p class="muted">no extension override available for this feature</p>
				{/if}
			</div>

			<div class="customization-grid-wrap">
				<div class="customization-grid">
					<div class="customization-grid-header mono">field</div>
					<div class="customization-grid-header">user-defined</div>
					<div class="customization-grid-header">extension-defined</div>

					<div class="mono customization-trait-key">template</div>
					<textarea
						class="customization-text-input customization-template-input"
						value={tokenCardTraitSummaryTemplate.userConfig.template}
						placeholder="empty = hidden"
						oninput={(event) => onTemplateInput('tokenCard', event)}
					></textarea>
					<textarea
						class="customization-readonly-input customization-template-input"
						value={tokenCardTraitSummaryTemplate.extensionConfig?.template ?? ''}
						placeholder="not available"
						readonly
					></textarea>
				</div>
			</div>

			<footer class="panel-footer customization-footer">
				<span class="muted">
					effective source:
					<span class="mono">{sourceButtonLabel(selectedSource(tokenCardTraitSummaryTemplate))}</span>
				</span>
				{#if tokenCardSaveMessage}
					<span class="muted">{tokenCardSaveMessage}</span>
				{/if}
				{#if tokenCardSaveError}
					<span class="muted">{tokenCardSaveError}</span>
				{/if}
				<button
					type="button"
					class="button-link"
					disabled={tokenCardSaving}
					aria-busy={tokenCardSaving}
					onclick={() => void onSave('tokenCard')}
				>
					save
				</button>
			</footer>
		</section>

		<section class="customization-feature-panel">
			<header class="panel-header">
				<div>
					<h2 class="customization-title">activity row trait summary template</h2>
					<p class="muted">render activity-row trait text from one template string</p>
				</div>
			</header>

			<div class="customization-section">
				<h3 class="customization-section-title">active source</h3>
				<div class="secondary-tabs" aria-label="Activity row trait summary source">
					{#if selectedSource(activityRowTraitSummaryTemplate) === 'user'}
						<span class="secondary-tab-active">{sourceButtonLabel('user')}</span>
					{:else}
						<button type="button" onclick={() => setTemplateFeatureSelectedSource('activityRow', 'user')}>
							{sourceButtonLabel('user')}
						</button>
					{/if}
					{#if extensionSourceAvailable(activityRowTraitSummaryTemplate)}
						{#if selectedSource(activityRowTraitSummaryTemplate) === 'extension'}
							<span class="secondary-tab-active">{sourceButtonLabel('extension')}</span>
						{:else}
							<button
								type="button"
								onclick={() => setTemplateFeatureSelectedSource('activityRow', 'extension')}
							>
								{sourceButtonLabel('extension')}
							</button>
						{/if}
					{:else}
						<span class="secondary-tab-disabled">{sourceButtonLabel('extension')}</span>
					{/if}
				</div>
				{#if !extensionSourceAvailable(activityRowTraitSummaryTemplate)}
					<p class="muted">no extension override available for this feature</p>
				{/if}
			</div>

			<div class="customization-grid-wrap">
				<div class="customization-grid">
					<div class="customization-grid-header mono">field</div>
					<div class="customization-grid-header">user-defined</div>
					<div class="customization-grid-header">extension-defined</div>

					<div class="mono customization-trait-key">template</div>
					<textarea
						class="customization-text-input customization-template-input"
						value={activityRowTraitSummaryTemplate.userConfig.template}
						placeholder="empty = hidden"
						oninput={(event) => onTemplateInput('activityRow', event)}
					></textarea>
					<textarea
						class="customization-readonly-input customization-template-input"
						value={activityRowTraitSummaryTemplate.extensionConfig?.template ?? ''}
						placeholder="not available"
						readonly
					></textarea>
				</div>
			</div>

			<footer class="panel-footer customization-footer">
				<span class="muted">
					effective source:
					<span class="mono">{sourceButtonLabel(selectedSource(activityRowTraitSummaryTemplate))}</span>
				</span>
				{#if activityRowSaveMessage}
					<span class="muted">{activityRowSaveMessage}</span>
				{/if}
				{#if activityRowSaveError}
					<span class="muted">{activityRowSaveError}</span>
				{/if}
				<button
					type="button"
					class="button-link"
					disabled={activityRowSaving}
					aria-busy={activityRowSaving}
					onclick={() => void onSave('activityRow')}
				>
					save
				</button>
			</footer>
		</section>
	</section>
</CollectionPageLayout>
