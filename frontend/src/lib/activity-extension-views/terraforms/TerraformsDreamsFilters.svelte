<script lang="ts">
	import {
		hashTerraformsCanvasRows,
		parseTerraformsCanvasRowsText
	} from '@artgod/shared/extensions/terraforms';
	import { resolveOwnerAddressRef } from '$lib/components/owner-ref';
	import type { ActivityExtensionFiltersProps } from '$lib/activity-extension-views/types';
	import {
		TERRAFORMS_DREAMS_FILTER_LABELS,
		TERRAFORMS_HEIGHTMAP_HASH_VISIBLE_CHARS
	} from '$lib/activity-extension-views/terraforms/constants';

	let { chainRef, filters, onApply }: ActivityExtensionFiltersProps = $props();

	let tokenDraft = $state(filters.tokenId ?? '');
	let makerDraft = $state(filters.maker ?? '');
	let heightmapDraft = $state('');
	let makerInvalid = $state(false);
	let heightmapInvalid = $state(false);
	let pending = $state(false);

	$effect(() => {
		tokenDraft = filters.tokenId ?? '';
		makerDraft = filters.maker ?? '';
		makerInvalid = false;
		heightmapInvalid = false;
	});

	async function onSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		pending = true;
		makerInvalid = false;
		heightmapInvalid = false;
		let heightmapHash: string | null = null;
		try {
			heightmapHash = resolveHeightmapHash();
		} catch {
			heightmapInvalid = true;
			pending = false;
			return;
		}
		try {
			const makerInput = makerDraft.trim();
			const maker = makerInput
				? await resolveOwnerAddressRef({
						fetchFn: fetch,
						chainRef,
						value: makerInput
					})
				: null;
			if (makerInput && !maker) {
				makerInvalid = true;
				return;
			}
			await onApply({
				tokenId: tokenDraft.trim() || null,
				maker,
				...(heightmapHash ? { contentHash: heightmapHash } : {})
			});
			if (heightmapHash) {
				heightmapDraft = '';
			}
		} catch {
			makerInvalid = true;
		} finally {
			pending = false;
		}
	}

	function resolveHeightmapHash(): string | null {
		if (!heightmapDraft.trim()) return null;
		const canvasRows = parseTerraformsCanvasRowsText(heightmapDraft);
		return hashTerraformsCanvasRows(canvasRows);
	}

	function visibleHash(hash: string): string {
		const normalized = hash.startsWith('0x') ? hash.slice(2) : hash;
		return normalized.slice(0, TERRAFORMS_HEIGHTMAP_HASH_VISIBLE_CHARS);
	}

	async function clearToken(): Promise<void> {
		tokenDraft = '';
		await onApply({ tokenId: null });
	}

	async function clearMaker(): Promise<void> {
		makerDraft = '';
		makerInvalid = false;
		await onApply({ maker: null });
	}

	async function clearHeightmap(): Promise<void> {
		await onApply({ contentHash: null });
	}
</script>

<form
	class="activity-extension-filters activity-extension-filters-stack terraforms-dreams-filters"
	onsubmit={onSubmit}
>
	<button class="terraforms-dreams-submit-button" type="submit" tabindex="-1">filter</button>
	<label class="activity-extension-filter-field activity-extension-filter-row">
		<span>{TERRAFORMS_DREAMS_FILTER_LABELS.Token}:</span>
		<span class="activity-extension-filter-control">
			<input
				class="activity-extension-filter-input terraforms-dreams-filter-input"
				type="text"
				inputmode="numeric"
				bind:value={tokenDraft}
				autocomplete="off"
				disabled={pending}
			/>
			{#if filters.tokenId || tokenDraft.trim()}
				<button
					class="facet-panel-action-button facet-reset-button activity-extension-filter-clear"
					type="button"
					title="reset token filter"
					aria-label="reset token filter"
					disabled={pending}
					onclick={clearToken}
				>
					x
				</button>
			{/if}
		</span>
	</label>
	<label class="activity-extension-filter-field activity-extension-filter-row">
		<span>{TERRAFORMS_DREAMS_FILTER_LABELS.Maker}:</span>
		<span class="activity-extension-filter-control">
			<input
				class="activity-extension-filter-input terraforms-dreams-filter-input"
				type="text"
				bind:value={makerDraft}
				aria-invalid={makerInvalid}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				disabled={pending}
			/>
			{#if filters.maker || makerDraft.trim()}
				<button
					class="facet-panel-action-button facet-reset-button activity-extension-filter-clear"
					type="button"
					title="reset maker filter"
					aria-label="reset maker filter"
					disabled={pending}
					onclick={clearMaker}
				>
					x
				</button>
			{/if}
		</span>
	</label>
	<label class="activity-extension-filter-field activity-extension-filter-row">
		<span>{TERRAFORMS_DREAMS_FILTER_LABELS.Heightmap}:</span>
		<span class="activity-extension-filter-control">
			<input
				class="activity-extension-filter-input terraforms-dreams-filter-input"
				type="text"
				bind:value={heightmapDraft}
				aria-invalid={heightmapInvalid}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				disabled={pending}
				oninput={() => (heightmapInvalid = false)}
			/>
		</span>
	</label>
	{#if filters.contentHash}
		<div class="activity-extension-filter-field activity-extension-filter-row">
			<span>{TERRAFORMS_DREAMS_FILTER_LABELS.Heightmap}:</span>
			<span class="activity-extension-filter-control">
				<span class="activity-extension-filter-active-value" title={filters.contentHash}>
					{visibleHash(filters.contentHash)}
				</span>
				<button
					class="facet-panel-action-button facet-reset-button activity-extension-filter-clear"
					type="button"
					title="reset heightmap filter"
					aria-label="reset heightmap filter"
					disabled={pending}
					onclick={clearHeightmap}
				>
					x
				</button>
			</span>
		</div>
	{/if}
</form>

<style>
	.terraforms-dreams-filters .activity-extension-filter-row {
		grid-template-columns: max-content auto;
		gap: 0.1rem;
	}

	.terraforms-dreams-filters .activity-extension-filter-row > span:first-child {
		min-width: 5.4rem;
		text-align: right;
	}

	.terraforms-dreams-filter-input {
		width: 20rem;
		max-width: min(72vw, 20rem);
	}

	.terraforms-dreams-submit-button {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		border: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
