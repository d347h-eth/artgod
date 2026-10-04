<script lang="ts">
	import {
		TRAIT_CATALOG_QUERY_PARAMS,
		type TradingCompetitionPreset,
		type TradingTraitCompetitionSelector
	} from '@artgod/shared/types';
	import {
		normalizeExtraCompetitionTraits,
		normalizeCompetitionPresetTarget,
		MAX_COMPETITION_PRESET_TARGET_TRAITS,
		competitionTraitsLabel
	} from '@artgod/shared/trading/trait-competition';
	import type { ApiChain, ApiCollection, ApiTraitFacet, ApiTraitCatalogFacet } from '$lib/api-types';
	import {
		BackendApiError,
		getCompetitionPresets,
		upsertCompetitionPreset,
		archiveCompetitionPreset,
		getCollectionTraitCatalog
	} from '$lib/backend-api';
	import BiddingTraitSelectors from './BiddingTraitSelectors.svelte';
	import { isConfirmationActionTarget } from '$lib/action-confirmation';

	let {
		chain,
		collection,
		facets,
		open,
		onClose = null,
		onPresetsChange
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		facets: ApiTraitFacet[];
		open: boolean;
		onClose?: (() => void) | null;
		onPresetsChange: (presets: TradingCompetitionPreset[]) => void;
	} = $props();
	let presets = $state<TradingCompetitionPreset[]>([]);
	let catalog = $state<ApiTraitCatalogFacet[]>([]);
	let targetTraits = $state<TradingTraitCompetitionSelector[]>([{ type: '', value: '' }]);
	let extras = $state<TradingTraitCompetitionSelector[]>([{ type: '', value: '' }]);
	let editing = $state<TradingCompetitionPreset | null>(null);
	let loading = $state(false);
	let catalogLoading = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let feedback = $state<string | null>(null);
	let armedAction = $state<string | null>(null);
	let requestGeneration = 0;
	const validation = $derived.by(() => {
		try {
			const target = normalizeCompetitionPresetTarget(targetTraits);
			const selectors = normalizeExtraCompetitionTraits(extras);
			const available = (trait: TradingTraitCompetitionSelector) =>
				catalog.some(
					(f) =>
						f.key === trait.type &&
						(trait.value === undefined || f.values.some((v) => v.value === trait.value))
				);
			if (!target.every(available) || !selectors.every(available)) return null;
			return selectors.length ? { target, selectors } : null;
		} catch {
			return null;
		}
	});
	$effect(() => {
		const chainRef = chain?.slug,
			collectionRef = collection?.slug;
		const generation = ++requestGeneration;
		presets = [];
		catalog = [];
		reset();
		loading = false;
		catalogLoading = false;
		busy = false;
		onPresetsChange([]);
		if (!chainRef || !collectionRef) return;
		loading = true;
		void getCompetitionPresets(fetch, chainRef, collectionRef)
			.then((response) => {
				if (generation !== requestGeneration) return;
				replacePresets(response.presets);
			})
			.catch(() => {
				if (generation === requestGeneration) error = 'Could not load extra targets. Refresh.';
			})
			.finally(() => {
				if (generation === requestGeneration) loading = false;
			});
		return () => {
			requestGeneration++;
		};
	});
	$effect(() => {
		const chainRef = chain?.slug,
			collectionRef = collection?.slug;
		const keys = facets.map((f) => f.key);
		if (!open || !chainRef || !collectionRef || !keys.length) return;
		let cancelled = false;
		catalogLoading = true;
		const params = new URLSearchParams({ [TRAIT_CATALOG_QUERY_PARAMS.Keys]: keys.join(',') });
		void getCollectionTraitCatalog(fetch, chainRef, collectionRef, params)
			.then((response) => {
				if (!cancelled) catalog = response.traitCatalog.facets;
			})
			.catch(() => {
				if (!cancelled) error = 'Could not load trait choices. Refresh.';
			})
			.finally(() => {
				if (!cancelled) catalogLoading = false;
			});
		return () => {
			cancelled = true;
		};
	});
	function reset(): void {
		editing = null;
		targetTraits = [{ type: '', value: '' }];
		extras = [{ type: '', value: '' }];
		armedAction = null;
		feedback = null;
		error = null;
	}
	function replacePresets(values: TradingCompetitionPreset[]): void {
		if (!Array.isArray(values)) throw new Error('Invalid preset response');
		presets = values;
		onPresetsChange(presets);
	}
	function edit(preset: TradingCompetitionPreset): void {
		reset();
		editing = preset;
		targetTraits = preset.targetTraits.map((t) => ({ ...t }));
		extras = preset.extraCompetitionTraits.map((t) => ({ ...t }));
	}
	async function refresh(): Promise<void> {
		if (!chain || !collection || busy) return;
		const generation = requestGeneration;
		const chainRef = chain.slug,
			collectionRef = collection.slug;
		const keys = facets.map((f) => f.key);
		loading = true;
		error = null;
		try {
			const response = await getCompetitionPresets(fetch, chainRef, collectionRef);
			if (generation !== requestGeneration) return;
			replacePresets(response.presets);
			if (keys.length) {
				const response = await getCollectionTraitCatalog(
					fetch,
					chainRef,
					collectionRef,
					new URLSearchParams({ [TRAIT_CATALOG_QUERY_PARAMS.Keys]: keys.join(',') })
				);
				if (generation !== requestGeneration) return;
				catalog = response.traitCatalog.facets;
			}
			reset();
		} catch {
			if (generation === requestGeneration) error = 'Could not load extra targets. Refresh.';
		} finally {
			if (generation === requestGeneration) loading = false;
		}
	}
	async function save(): Promise<void> {
		if (!chain || !collection || busy || !validation) return;
		if (armedAction !== 'save') {
			armedAction = 'save';
			return;
		}
		const generation = requestGeneration;
		busy = true;
		error = null;
		try {
			const response = await upsertCompetitionPreset(fetch, chain.slug, collection.slug, {
				...(editing ? { presetId: editing.presetId, expectedRevision: editing.revision } : {}),
				targetTraits: validation.target,
				extraCompetitionTraits: validation.selectors
			});
			if (generation !== requestGeneration) return;
			replacePresets(response.presets);
			reset();
			feedback = 'saved';
		} catch (cause) {
			if (generation === requestGeneration)
				error = presetError(
					cause,
					`Could not save extra targets. Try ${editing ? 'modify' : 'create'} again.`
				);
		} finally {
			if (generation === requestGeneration) {
				busy = false;
				armedAction = null;
			}
		}
	}
	async function archive(preset: TradingCompetitionPreset): Promise<void> {
		if (!chain || !collection || busy) return;
		if (armedAction !== preset.presetId) {
			armedAction = preset.presetId;
			return;
		}
		const generation = requestGeneration;
		busy = true;
		error = null;
		try {
			const response = await archiveCompetitionPreset(
				fetch,
				chain.slug,
				collection.slug,
				preset.presetId,
				preset.revision
			);
			if (generation !== requestGeneration) return;
			replacePresets(response.presets);
			if (editing?.presetId === preset.presetId) reset();
			feedback = 'archived';
		} catch (cause) {
			if (generation === requestGeneration)
				error = presetError(cause, 'Could not archive extra targets. Try archive again.');
		} finally {
			if (generation === requestGeneration) {
				busy = false;
				armedAction = null;
			}
		}
	}
	function presetError(cause: unknown, fallback: string): string {
		return cause instanceof BackendApiError && [400, 409, 422].includes(cause.status)
			? cause.message
			: fallback;
	}
	function clearConfirmation(event: PointerEvent | FocusEvent): void {
		if (
			!busy &&
			!isConfirmationActionTarget(event.target, armedAction, 'data-competition-preset-action')
		) {
			armedAction = null;
		}
	}
	$effect(() => {
		if (!open) armedAction = null;
	});
</script>

<svelte:window onpointerdown={clearConfirmation} onfocusin={clearConfirmation} />

{#if open}
	<section class="runtime-section bidding-price-tier-panel" aria-label="extra targets presets">
		<header class="panel-header bidding-price-tier-header">
			<h2 class="panel-title">extra targets</h2>
			<div class="runtime-controls">
				<button
					type="button"
					class="action-button-neutral"
					onclick={refresh}
					disabled={busy || loading}
				>
					refresh
				</button>
				{#if onClose}
					<button type="button" class="button-link" onclick={onClose}>hide</button>
				{/if}
			</div>
		</header>
		{#if presets.length}
			<div class="table-wrap bidding-price-tier-table-wrap">
				<table class="bidding-price-tier-table">
					<thead>
						<tr>
							<th>target</th>
							<th>extra targets</th>
							<th>rev</th>
							<th>actions</th>
						</tr>
					</thead>
					<tbody>
						{#each presets as preset (preset.presetId)}
							<tr>
								<td class="mono">{competitionTraitsLabel(preset.targetTraits)}</td>
								<td class="mono">{competitionTraitsLabel(preset.extraCompetitionTraits)}</td>
								<td class="mono tier-cell-center">{preset.revision}</td>
								<td>
									<div class="tier-row-actions">
										<button
											type="button"
											class="token-bidding-action-negative"
											class:token-bidding-action-armed={armedAction === preset.presetId}
											data-competition-preset-action={preset.presetId}
											onclick={() => archive(preset)}
											disabled={busy || loading}
										>
											archive
										</button>
										<button
											type="button"
											class="action-button-neutral"
											onclick={() => edit(preset)}
											disabled={busy || loading}
										>
											edit
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		<form class="bootstrap-form bidding-price-tier-form" onsubmit={(event) => event.preventDefault()}>
			<div class="runtime-kv-grid token-bidding-runtime-grid bidding-price-tier-form-summary">
				<div>
					<span class="runtime-k">mode</span>
					<span class="runtime-v">{editing ? 'edit' : 'create'}</span>
				</div>
			</div>
			<div class="bootstrap-form-row bootstrap-form-row-textarea">
				<label for="extra-target-source-key-1"><span>target</span></label>
				<BiddingTraitSelectors
					selectors={targetTraits}
					{catalog}
					availableTargets={facets}
					allowAny
					maxSelectors={MAX_COMPETITION_PRESET_TARGET_TRAITS}
					uniqueKeys
					idPrefix="extra-target-source"
					label="target trait"
					disabled={busy || loading || catalogLoading}
					onChange={(value) => {
						targetTraits = value;
						armedAction = null;
					}}
				/>
			</div>
			<div class="bootstrap-form-row bootstrap-form-row-textarea">
				<label for="extra-target-extra-key-1"><span>extra targets</span></label>
				<BiddingTraitSelectors
					selectors={extras}
					{catalog}
					allowAny
					label="extra target"
					idPrefix="extra-target-extra"
					disabled={busy || loading || catalogLoading}
					onChange={(value) => {
						extras = value;
						armedAction = null;
					}}
				/>
			</div>
			<div class="panel-footer bidding-price-tier-form-footer">
				<button
					type="button"
					class="facet-panel-action-button facet-reset-button"
					onclick={reset}
					disabled={busy}
				>
					reset
				</button>
				<button
					type="button"
					class="token-bidding-action-positive"
					class:token-bidding-action-armed={armedAction === 'save'}
					data-competition-preset-action="save"
					disabled={busy || loading || catalogLoading || !validation}
					onclick={save}
				>
					{busy && armedAction === 'save' ? 'saving...' : editing ? 'modify' : 'create'}
				</button>
			</div>
			<div class="bootstrap-form-feedback bidding-price-tier-feedback">
				{#if loading || catalogLoading}
					<p class="muted token-bidding-feedback" role="status">loading...</p>
				{/if}
				{#if error}
					<p class="runtime-error token-bidding-feedback" role="alert">{error}</p>
				{/if}
				{#if feedback}
					<p class="runtime-pass token-bidding-feedback" role="status">{feedback}</p>
				{/if}
			</div>
		</form>
	</section>
{/if}
