<script lang="ts">
	import {
		TRAIT_CATALOG_QUERY_PARAMS,
		type TradingCompetitionPreset,
		type TradingTraitCriterion,
		type TradingTraitCompetitionSelector
	} from '@artgod/shared/types';
	import {
		normalizeExtraCompetitionTraits,
		normalizeTraitBiddingTarget,
		competitionTraitsLabel
	} from '@artgod/shared/trading/trait-competition';
	import type { ApiChain, ApiCollection, ApiTraitFacet, ApiTraitCatalogFacet } from '$lib/api-types';
	import {
		getCompetitionPresets,
		upsertCompetitionPreset,
		archiveCompetitionPreset,
		getCollectionTraitCatalog
	} from '$lib/backend-api';
	import BiddingTraitSelectors from './BiddingTraitSelectors.svelte';

	let {
		chain,
		collection,
		facets,
		open,
		onClose,
		onPresetsChange
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		facets: ApiTraitFacet[];
		open: boolean;
		onClose: () => void;
		onPresetsChange: (presets: TradingCompetitionPreset[]) => void;
	} = $props();
	let presets = $state<TradingCompetitionPreset[]>([]);
	let catalog = $state<ApiTraitCatalogFacet[]>([]);
	let targetTraits = $state<TradingTraitCriterion[]>([]);
	let extras = $state<TradingTraitCompetitionSelector[]>([]);
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
			const target = normalizeTraitBiddingTarget(targetTraits);
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
				if (generation === requestGeneration)
					error = 'Could not load competitive extras. Refresh presets.';
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
				if (!cancelled) error = 'Could not load trait choices. Refresh presets.';
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
		targetTraits = [];
		extras = [];
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
			if (generation === requestGeneration)
				error = 'Could not refresh competitive extras. Try again.';
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
				error = cause instanceof Error ? cause.message : 'Could not save preset. Try again.';
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
				error = cause instanceof Error ? cause.message : 'Could not archive preset. Try again.';
		} finally {
			if (generation === requestGeneration) {
				busy = false;
				armedAction = null;
			}
		}
	}
</script>

{#if open}
	<section class="token-bidding-runtime-panel competition-presets" aria-label="competitive extras presets">
		<div class="panel-header">
			<h3>competitive extras</h3>
			<div class="secondary-tabs">
				<button type="button" onclick={refresh} disabled={busy || loading}>refresh</button>
				<button type="button" onclick={onClose}>hide</button>
			</div>
		</div>
		{#if error}
			<p class="runtime-error" role="alert">{error}</p>
		{/if}
		{#if feedback}
			<p class="runtime-v" role="status">{feedback}</p>
		{/if}
		{#if loading || catalogLoading}
			<p class="runtime-v" role="status">loading</p>
		{/if}
		{#each presets as preset (preset.presetId)}
			<div class="preset-row">
				<span class="mono">
					{competitionTraitsLabel(preset.targetTraits)} → {competitionTraitsLabel(preset.extraCompetitionTraits)}
				</span>
				<span class="runtime-k">v{preset.revision}</span>
				<button type="button" onclick={() => edit(preset)} disabled={busy || loading}>edit</button>
				<button
					type="button"
					class="action-button-negative"
					onclick={() => archive(preset)}
					disabled={busy || loading}
				>
					{armedAction === preset.presetId ? 'confirm archive' : 'archive'}
				</button>
			</div>
		{/each}
		<form class="bootstrap-form" onsubmit={(event) => event.preventDefault()}>
			<div class="bootstrap-form-row">
				<span class="runtime-k">target</span>
				<BiddingTraitSelectors
					selectors={targetTraits}
					{catalog}
					availableTargets={facets}
					label="target trait"
					disabled={busy || loading || catalogLoading}
					onChange={(value) => {
						targetTraits = value.map((t) => ({ type: t.type, value: t.value ?? '' }));
						armedAction = null;
					}}
				/>
			</div>
			<div class="bootstrap-form-row">
				<span class="runtime-k">extras</span>
				<BiddingTraitSelectors
					selectors={extras}
					{catalog}
					allowAny
					label="competitive extra"
					disabled={busy || loading || catalogLoading}
					onChange={(value) => {
						extras = value;
						armedAction = null;
					}}
				/>
			</div>
			<div class="panel-footer">
				<button type="button" onclick={reset} disabled={busy}>reset</button>
				<button
					type="button"
					class="action-button-positive"
					disabled={busy || loading || catalogLoading || !validation}
					onclick={save}
				>
					{busy && armedAction === 'save' ? 'saving' : armedAction === 'save' ? (editing ? 'confirm modify' : 'confirm create') : editing ? 'modify' : 'create'}
				</button>
			</div>
		</form>
	</section>
{/if}

<style>
	.competition-presets {
		width: fit-content;
		max-width: 100%;
		margin: 0 auto 1rem;
		min-width: min(32rem, 100%);
	}
	.panel-header,
	.preset-row {
		display: flex;
		gap: 0.65rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.preset-row {
		padding: 0.45rem 0;
	}
	.preset-row > span:first-child {
		overflow-wrap: anywhere;
	}
	.bootstrap-form-row {
		grid-template-columns: 4rem minmax(0, 1fr);
		column-gap: 0.6rem;
		align-items: start;
	}
</style>
