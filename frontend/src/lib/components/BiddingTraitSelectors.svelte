<script lang="ts">
	import type { TradingTraitCompetitionSelector } from '@artgod/shared/types';
	import { MAX_EXTRA_COMPETITION_TRAITS } from '@artgod/shared/trading/trait-competition';
	import type { ApiTraitCatalogFacet, ApiTraitFacet } from '$lib/api-types';

	const ANY_VALUE = '*';
	const EXACT_VALUE_PREFIX = 'value:';
	let {
		selectors,
		catalog,
		availableTargets = [],
		allowAny = false,
		label,
		disabled,
		onChange
	}: {
		selectors: TradingTraitCompetitionSelector[];
		catalog: ApiTraitCatalogFacet[];
		availableTargets?: ApiTraitFacet[];
		allowAny?: boolean;
		label: string;
		disabled: boolean;
		onChange: (selectors: TradingTraitCompetitionSelector[]) => void;
	} = $props();
	function update(index: number, selector: TradingTraitCompetitionSelector): void {
		onChange(selectors.map((entry, position) => (position === index ? selector : entry)));
	}
	function targetUnavailable(key: string, value: string): boolean {
		return (
			!allowAny &&
			availableTargets.find((f) => f.key === key)?.values.find((v) => v.value === value)
				?.marketplaceBiddingSupported === false
		);
	}
</script>

<div class="trait-selectors" role="group" aria-label={label}>
	{#each selectors as selector, index}
		<div class="trait-selector-row">
			<select
				class="bootstrap-control"
				aria-label={`${label} key ${index + 1}`}
				value={selector.type}
				{disabled}
				onchange={(event) => update(index, {
					type: event.currentTarget.value,
					...(allowAny ? {} : { value: '' })
				})}
			>
				<option value="" disabled>trait</option>
				{#if selector.type && !catalog.some((f) => f.key === selector.type)}
					<option value={selector.type} disabled>{selector.type} (unavailable)</option>
				{/if}
				{#each catalog as facet}
					<option value={facet.key}>{facet.key}</option>
				{/each}
			</select>
			<select
				class="bootstrap-control"
				aria-label={`${label} value ${index + 1}`}
				value={selector.value === undefined ? ANY_VALUE : `${EXACT_VALUE_PREFIX}${selector.value}`}
				disabled={disabled || !selector.type}
				onchange={(event) => update(index, event.currentTarget.value === ANY_VALUE
					? { type: selector.type }
					: { type: selector.type, value: event.currentTarget.value.slice(EXACT_VALUE_PREFIX.length) })}
			>
				{#if allowAny}
					<option value={ANY_VALUE}>any</option>
				{:else}
					<option value={EXACT_VALUE_PREFIX} disabled>value</option>
				{/if}
				{#if selector.value && !catalog.find((f) => f.key === selector.type)?.values.some((v) => v.value === selector.value)}
					<option value={`${EXACT_VALUE_PREFIX}${selector.value}`} disabled>
						{selector.value} (unavailable)
					</option>
				{/if}
				{#each catalog.find((f) => f.key === selector.type)?.values ?? [] as entry}
					<option
						value={`${EXACT_VALUE_PREFIX}${entry.value}`}
						disabled={targetUnavailable(selector.type, entry.value)}
					>
						{entry.value}
					</option>
				{/each}
			</select>
			<button
				type="button"
				class="action-button-negative"
				aria-label={`remove ${label} ${index + 1}`}
				{disabled}
				onclick={() => onChange(selectors.filter((_, i) => i !== index))}
			>
				remove
			</button>
		</div>
	{/each}
	<button
		type="button"
		class="action-button-positive"
		disabled={disabled || selectors.length >= MAX_EXTRA_COMPETITION_TRAITS || catalog.length === 0}
		onclick={() => onChange([...selectors, { type: '', ...(allowAny ? {} : { value: '' }) }])}
	>
		add
	</button>
</div>

<style>
	.trait-selectors {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
	}
	.trait-selectors > button {
		justify-self: start;
	}
	.trait-selector-row {
		display: grid;
		grid-template-columns: minmax(7rem, 1fr) minmax(7rem, 1fr) auto;
		gap: 0.5rem;
		align-items: center;
	}
	.trait-selector-row select {
		min-width: 0;
		width: 100%;
	}
	@media (max-width: 480px) {
		.trait-selector-row {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
		.trait-selector-row button {
			justify-self: start;
		}
	}
</style>
