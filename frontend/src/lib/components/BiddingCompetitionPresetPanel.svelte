<script lang="ts">
	import { untrack } from 'svelte';
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
	import type {
		ApiChain,
		ApiCollection,
		ApiTraitFacet,
		ApiTraitCatalogFacet,
		ApiBiddingJob,
		ApiCompetitionPresetReapplyJobPreview,
		CompetitionPresetReapplyPreviewApiResponse
	} from '$lib/api-types';
	import {
		BackendApiError,
		getCompetitionPresets,
		upsertCompetitionPreset,
		archiveCompetitionPreset,
		getCollectionTraitCatalog,
		previewCompetitionPresetReapply,
		applyCompetitionPresetReapply
	} from '$lib/backend-api';
	import BiddingTraitSelectors from './BiddingTraitSelectors.svelte';
	import BiddingJobReapplyPreview from './BiddingJobReapplyPreview.svelte';
	import {
		isConfirmationActionTarget,
		BIDDING_JOB_REAPPLY_ACTION_KEY
	} from '$lib/action-confirmation';
	import type { BiddingCompetitionPresetInventory } from '$lib/bidding-competition-presets';

	const presetFieldHelp = {
		target:
			'Choose which of your trait bidding jobs can use this preset. Their targets must use exactly these one or two keys and match the selected values. any (all) accepts every value of a key. The source target is fixed after creation; create a new preset for a different source. After saving, select this preset under extra targets when creating or modifying a matching job.',
		extras:
			'Add bids for other traits to the competition your bot uses to set its price. The bot already considers collection-wide bids and bids for your job’s target traits, alone or together. Each extra includes bids targeting that trait alone; any (all) includes every value of the key. Your bid target and price limits stay unchanged. Existing jobs keep their selected preset version until you update them with modify or reapply.'
	};

	let {
		chain,
		collection,
		facets,
		open,
		onClose = null,
		onInventoryChange,
		onJobsChange = null,
		reapplyEnabled = false
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		facets: ApiTraitFacet[];
		open: boolean;
		onClose?: (() => void) | null;
		onInventoryChange: (inventory: BiddingCompetitionPresetInventory) => void;
		onJobsChange?: ((jobs: ApiBiddingJob[]) => void) | null;
		reapplyEnabled?: boolean;
	} = $props();
	let presets = $state<TradingCompetitionPreset[]>([]);
	let catalog = $state<ApiTraitCatalogFacet[]>([]);
	let targetTraits = $state<TradingTraitCompetitionSelector[]>([{ type: '', value: '' }]);
	let extras = $state<TradingTraitCompetitionSelector[]>([{ type: '', value: '' }]);
	let editing = $state<TradingCompetitionPreset | null>(null);
	let loading = $state(false);
	let catalogLoading = $state(false);
	let writing = $state(false);
	let reapplyLoading = $state(false);
	let reapplyApplying = $state(false);
	let reapplyPreview = $state<CompetitionPresetReapplyPreviewApiResponse | null>(null);
	let selectedJobIds = $state<string[]>([]);
	const busy = $derived(writing || reapplyLoading || reapplyApplying);
	const reapplyColumns = [
		{
			label: 'qty',
			format: (row: ApiCompetitionPresetReapplyJobPreview) =>
				row.job.target.type === 'collection' ? String(row.job.target.quantity) : ''
		},
		{ label: 'status', format: (row: ApiCompetitionPresetReapplyJobPreview) => row.job.status },
		{
			label: 'rev',
			format: (row: ApiCompetitionPresetReapplyJobPreview) =>
				`${row.before.revision} -> ${row.after.revision}`
		},
		{
			label: 'extra targets',
			format: (row: ApiCompetitionPresetReapplyJobPreview) =>
				`${competitionTraitsLabel(row.before.extraCompetitionTraits)} -> ${competitionTraitsLabel(row.after.extraCompetitionTraits)}`
		}
	];
	let error = $state<string | null>(null);
	let inventoryError = $state<string | null>(null);
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
		inventoryError = null;
		catalogLoading = false;
		writing = false;
		reapplyLoading = false;
		reapplyApplying = false;
		if (!chainRef || !collectionRef) return;
		void loadInventory(chainRef, collectionRef, generation);
		return () => {
			requestGeneration++;
		};
	});
	$effect(() => {
		const inventory: BiddingCompetitionPresetInventory = {
			presets,
			loading,
			error: inventoryError,
			refresh: refreshInventory
		};
		untrack(() => onInventoryChange(inventory));
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
		reapplyPreview = null;
		selectedJobIds = [];
	}
	function replacePresets(values: TradingCompetitionPreset[]): void {
		if (!Array.isArray(values)) throw new Error('Invalid preset response');
		presets = values;
	}
	function edit(preset: TradingCompetitionPreset): void {
		reset();
		editing = preset;
		targetTraits = preset.targetTraits.map((t) => ({ ...t }));
		extras = preset.extraCompetitionTraits.map((t) => ({ ...t }));
	}
	async function loadInventory(
		chainRef: string,
		collectionRef: string,
		generation: number
	): Promise<boolean> {
		loading = true;
		inventoryError = null;
		try {
			const response = await getCompetitionPresets(fetch, chainRef, collectionRef);
			if (generation !== requestGeneration) return false;
			replacePresets(response.presets);
			return true;
		} catch {
			if (generation === requestGeneration) inventoryError = 'Could not load extra targets. Refresh.';
			return false;
		} finally {
			if (generation === requestGeneration) loading = false;
		}
	}
	async function refreshInventory(): Promise<void> {
		if (!chain || !collection || busy || loading) return;
		await loadInventory(chain.slug, collection.slug, requestGeneration);
	}
	async function refresh(): Promise<void> {
		if (!chain || !collection || busy || loading || catalogLoading) return;
		const generation = requestGeneration;
		const chainRef = chain.slug,
			collectionRef = collection.slug;
		const keys = facets.map((f) => f.key);
		error = null;
		if (!(await loadInventory(chainRef, collectionRef, generation))) return;
		catalogLoading = true;
		try {
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
			if (generation === requestGeneration) error = 'Could not load trait choices. Refresh.';
		} finally {
			if (generation === requestGeneration) catalogLoading = false;
		}
	}
	async function save(): Promise<void> {
		if (!chain || !collection || busy || !validation) return;
		if (armedAction !== 'save') {
			armedAction = 'save';
			return;
		}
		const generation = requestGeneration;
		writing = true;
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
				writing = false;
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
		writing = true;
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
			if (reapplyPreview?.preset.presetId === preset.presetId) {
				reapplyPreview = null;
				selectedJobIds = [];
			}
			feedback = 'archived';
		} catch (cause) {
			if (generation === requestGeneration)
				error = presetError(cause, 'Could not archive extra targets. Try archive again.');
		} finally {
			if (generation === requestGeneration) {
				writing = false;
				armedAction = null;
			}
		}
	}
	async function previewReapply(preset: TradingCompetitionPreset): Promise<void> {
		if (!chain || !collection || busy || !reapplyEnabled) return;
		const generation = requestGeneration;
		reapplyLoading = true;
		error = null;
		feedback = null;
		armedAction = null;
		try {
			const response = await previewCompetitionPresetReapply(
				fetch,
				chain.slug,
				collection.slug,
				preset.presetId
			);
			if (generation !== requestGeneration) return;
			reapplyPreview = response;
			presets = presets.map((value) =>
				value.presetId === response.preset.presetId ? response.preset : value
			);
			selectedJobIds = response.jobs
				.filter((row) => row.changed && !row.error)
				.map((row) => row.job.jobId);
		} catch (cause) {
			if (generation === requestGeneration) {
				reapplyPreview = null;
				selectedJobIds = [];
				error = presetError(cause, 'Could not preview extra targets. Try reapply again.');
			}
		} finally {
			if (generation === requestGeneration) reapplyLoading = false;
		}
	}
	function toggleReapplyJob(jobId: string): void {
		if (busy) return;
		const selected = new Set(selectedJobIds);
		if (selected.has(jobId)) selected.delete(jobId);
		else selected.add(jobId);
		selectedJobIds = [...selected];
		armedAction = null;
	}
	async function applyReapply(): Promise<void> {
		if (!chain || !collection || !reapplyPreview || busy || !selectedJobIds.length || !reapplyEnabled)
			return;
		if (armedAction !== BIDDING_JOB_REAPPLY_ACTION_KEY) {
			armedAction = BIDDING_JOB_REAPPLY_ACTION_KEY;
			return;
		}
		const generation = requestGeneration;
		const chainRef = chain.slug,
			collectionRef = collection.slug;
		const reviewed = reapplyPreview;
		const selected = new Set(selectedJobIds);
		reapplyApplying = true;
		error = null;
		feedback = null;
		try {
			const response = await applyCompetitionPresetReapply(
				fetch,
				chainRef,
				collectionRef,
				reviewed.preset.presetId,
				{
					expectedRevision: reviewed.preset.revision,
					jobs: reviewed.jobs
						.filter((row) => selected.has(row.job.jobId))
						.map((row) => ({
							jobId: row.job.jobId,
							expectedRevision: row.job.revision,
							versionId: row.before.versionId
						}))
				}
			);
			if (generation !== requestGeneration) return;
			onJobsChange?.(response.jobs);
			reapplyPreview = null;
			selectedJobIds = [];
			feedback = 'reapplied';
			// Keep a successful write distinct from a failed follow-up read.
			try {
				const preview = await previewCompetitionPresetReapply(
					fetch,
					chainRef,
					collectionRef,
					reviewed.preset.presetId
				);
				if (generation !== requestGeneration) return;
				reapplyPreview = preview;
				selectedJobIds = preview.jobs
					.filter((row) => row.changed && !row.error)
					.map((row) => row.job.jobId);
			} catch {
				if (generation === requestGeneration)
					error = 'Jobs updated. Could not refresh the preview. Try reapply again.';
			}
		} catch (cause) {
			if (generation === requestGeneration)
				error = presetError(cause, 'Could not reapply extra targets. Try apply again.');
		} finally {
			if (generation === requestGeneration) {
				reapplyApplying = false;
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
					class="button-link action-button-neutral"
					onclick={refresh}
					disabled={busy || loading || catalogLoading}
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
										<button type="button" class="action-button-neutral"
											onclick={() => void previewReapply(preset)} disabled={busy || loading || !reapplyEnabled}
										>reapply</button>
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
		{#if reapplyLoading}
			<p class="muted token-bidding-feedback" role="status">loading...</p>
		{/if}
		{#if reapplyPreview}
			<div class="bidding-price-tier-reapply-wrap">
				<BiddingJobReapplyPreview jobs={reapplyPreview.jobs} {selectedJobIds}
					applying={reapplyApplying} disabled={busy || !reapplyEnabled} armedActionKey={armedAction}
					onToggleJob={toggleReapplyJob} onApply={applyReapply}
					columns={reapplyColumns} label="extra targets reapply preview"
					emptyLabel="no jobs use this preset" selectionLabel="extra targets reapply"
					actionAttribute="data-competition-preset-action"
				/>
			</div>
		{/if}
		<form class="bootstrap-form bidding-price-tier-form" onsubmit={(event) => event.preventDefault()}>
			<div class="runtime-kv-grid token-bidding-runtime-grid bidding-price-tier-form-summary">
				<div>
					<span class="runtime-k">mode</span>
					<span class="runtime-v">{editing ? 'edit' : 'create'}</span>
				</div>
			</div>
			<BiddingTraitSelectors
				selectors={targetTraits}
				{catalog}
				availableTargets={facets}
				allowAny
				maxSelectors={MAX_COMPETITION_PRESET_TARGET_TRAITS}
				uniqueKeys
				idPrefix="extra-target-source"
				label="source target"
				help={presetFieldHelp.target}
				disabled={editing !== null || busy || loading || catalogLoading}
				onChange={(value) => {
					targetTraits = value;
					armedAction = null;
				}}
			/>
			<BiddingTraitSelectors
				selectors={extras}
				{catalog}
				allowAny
				label="extra target"
				fieldLabel="extra targets"
				help={presetFieldHelp.extras}
				idPrefix="extra-target-extra"
				disabled={busy || loading || catalogLoading}
				onChange={(value) => {
					extras = value;
					armedAction = null;
				}}
			/>
			<div class="panel-footer bidding-price-tier-form-footer">
				<button type="button" onclick={reset} disabled={busy}>reset</button>
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
				{#if error || inventoryError}
					<p class="runtime-error token-bidding-feedback" role="alert">{error ?? inventoryError}</p>
				{/if}
				{#if feedback}
					<p class="runtime-pass token-bidding-feedback" role="status">{feedback}</p>
				{/if}
			</div>
		</form>
	</section>
{/if}
