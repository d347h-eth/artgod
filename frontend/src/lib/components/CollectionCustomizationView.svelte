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
	let traitFilterSaving = $state(false);
	let traitFilterSaveMessage = $state<string | null>(null);
	let traitFilterSaveError = $state<string | null>(null);
	let tokenCardSaving = $state(false);
	let tokenCardSaveMessage = $state<string | null>(null);
	let tokenCardSaveError = $state<string | null>(null);
	let activityRowSaving = $state(false);
	let activityRowSaveMessage = $state<string | null>(null);
	let activityRowSaveError = $state<string | null>(null);

	$effect(() => {
		traitFilterPresentation =
			customization?.traitFilterPresentation ?? fallbackTraitFilterPresentationState();
		tokenCardTraitSummaryTemplate =
			customization?.tokenCardTraitSummaryTemplate ?? fallbackTraitSummaryTemplateState();
		activityRowTraitSummaryTemplate =
			customization?.activityRowTraitSummaryTemplate ?? fallbackTraitSummaryTemplateState();
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
		if (!(target instanceof HTMLInputElement)) return;
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

	function applyCustomizationState(
		nextCustomization: CollectionCustomizationApiResponse['customization']
	): void {
		traitFilterPresentation = nextCustomization.traitFilterPresentation;
		tokenCardTraitSummaryTemplate = nextCustomization.tokenCardTraitSummaryTemplate;
		activityRowTraitSummaryTemplate = nextCustomization.activityRowTraitSummaryTemplate;
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
	}

	async function onSave(
		feature: 'traitFilter' | 'tokenCard' | 'activityRow'
	): Promise<void> {
		if (!chain || !collection) return;
		if (
			(feature === 'traitFilter' && traitFilterSaving) ||
			(feature === 'tokenCard' && tokenCardSaving) ||
			(feature === 'activityRow' && activityRowSaving)
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
		} else {
			activityRowSaving = true;
			activityRowSaveMessage = null;
			activityRowSaveError = null;
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
			} else {
				activityRowSaveMessage = 'saved';
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'failed to update collection customization';
			if (feature === 'traitFilter') {
				traitFilterSaveError = message;
			} else if (feature === 'tokenCard') {
				tokenCardSaveError = message;
			} else {
				activityRowSaveError = message;
			}
		} finally {
			if (feature === 'traitFilter') {
				traitFilterSaving = false;
			} else if (feature === 'tokenCard') {
				tokenCardSaving = false;
			} else {
				activityRowSaving = false;
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
					<input
						class="customization-text-input customization-template-input"
						type="text"
						value={tokenCardTraitSummaryTemplate.userConfig.template}
						placeholder="empty = hidden"
						oninput={(event) => onTemplateInput('tokenCard', event)}
					/>
					<input
						class="customization-readonly-input customization-template-input"
						type="text"
						value={tokenCardTraitSummaryTemplate.extensionConfig?.template ?? ''}
						placeholder="not available"
						readonly
					/>
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
					<input
						class="customization-text-input customization-template-input"
						type="text"
						value={activityRowTraitSummaryTemplate.userConfig.template}
						placeholder="empty = hidden"
						oninput={(event) => onTemplateInput('activityRow', event)}
					/>
					<input
						class="customization-readonly-input customization-template-input"
						type="text"
						value={activityRowTraitSummaryTemplate.extensionConfig?.template ?? ''}
						placeholder="not available"
						readonly
					/>
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
