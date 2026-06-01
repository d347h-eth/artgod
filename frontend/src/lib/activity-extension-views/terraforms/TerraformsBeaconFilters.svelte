<script lang="ts">
	import { TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS } from '@artgod/shared/extensions/terraforms';
	import { resolveOwnerAddressRef } from '$lib/components/owner-ref';
	import type { ActivityExtensionFiltersProps } from '$lib/activity-extension-views/types';
	import { TERRAFORMS_BEACON_FILTER_LABELS } from '$lib/activity-extension-views/terraforms/constants';

	let { chainRef, feed, filters, onApply }: ActivityExtensionFiltersProps = $props();

	let tokenDraft = $state(filters.tokenId ?? '');
	let makerDraft = $state(filters.maker ?? '');
	let eventGroupDraft = $state(filters.eventGroup ?? '');
	let makerInvalid = $state(false);
	let pending = $state(false);
	let eventGroupOptions = $derived(
		feed.filters?.eventGroup?.options ?? [...TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS]
	);

	$effect(() => {
		tokenDraft = filters.tokenId ?? '';
		makerDraft = filters.maker ?? '';
		eventGroupDraft = filters.eventGroup ?? '';
		makerInvalid = false;
	});

	async function onSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		pending = true;
		makerInvalid = false;
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
				eventGroup: eventGroupDraft || null
			});
		} catch {
			makerInvalid = true;
		} finally {
			pending = false;
		}
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

	async function clearEventGroup(): Promise<void> {
		eventGroupDraft = '';
		await onApply({ eventGroup: null });
	}

	async function applyEventGroup(event: Event): Promise<void> {
		eventGroupDraft = (event.currentTarget as HTMLSelectElement).value;
		pending = true;
		try {
			await onApply({ eventGroup: eventGroupDraft || null });
		} finally {
			pending = false;
		}
	}
</script>

<form
	class="activity-extension-filters activity-extension-filters-stack terraforms-beacon-filters"
	onsubmit={onSubmit}
>
	<button class="terraforms-beacon-submit-button" type="submit" tabindex="-1">filter</button>
	<label class="activity-extension-filter-field activity-extension-filter-row">
		<span>{TERRAFORMS_BEACON_FILTER_LABELS.Token}:</span>
		<span class="activity-extension-filter-control">
			<input
				class="activity-extension-filter-input terraforms-beacon-filter-input"
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
		<span>{TERRAFORMS_BEACON_FILTER_LABELS.Maker}:</span>
		<span class="activity-extension-filter-control">
			<input
				class="activity-extension-filter-input terraforms-beacon-filter-input"
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
		<span>{TERRAFORMS_BEACON_FILTER_LABELS.Type}:</span>
		<span class="activity-extension-filter-control">
			<select
				class="activity-extension-filter-input terraforms-beacon-filter-input"
				bind:value={eventGroupDraft}
				disabled={pending}
				onchange={applyEventGroup}
			>
				<option value=""></option>
				{#each eventGroupOptions as option}
					<option value={option.key}>{option.label}</option>
				{/each}
			</select>
			{#if filters.eventGroup || eventGroupDraft}
				<button
					class="facet-panel-action-button facet-reset-button activity-extension-filter-clear"
					type="button"
					title="reset type filter"
					aria-label="reset type filter"
					disabled={pending}
					onclick={clearEventGroup}
				>
					x
				</button>
			{/if}
		</span>
	</label>
</form>

<style>
	.terraforms-beacon-filters .activity-extension-filter-row {
		grid-template-columns: max-content auto;
		gap: 0.1rem;
	}

	.terraforms-beacon-filters .activity-extension-filter-row > span:first-child {
		min-width: 5.4rem;
		text-align: right;
	}

	.terraforms-beacon-filter-input {
		width: 15rem;
		max-width: min(72vw, 15rem);
	}

	.terraforms-beacon-submit-button {
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
