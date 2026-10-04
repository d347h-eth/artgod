<script lang="ts">
	import type { TradingTraitCompetitionSelector } from '@artgod/shared/types';
	import { MAX_EXTRA_COMPETITION_TRAITS } from '@artgod/shared/trading/trait-competition';
	import type { ApiTraitCatalogFacet, ApiTraitFacet } from '$lib/api-types';
	import InfoTooltip from './InfoTooltip.svelte';

	const ANY_VALUE = '*';
	const ANY_VALUE_LABEL = 'any (all)';
	const EXACT_VALUE_PREFIX = 'value:';
	let {
		selectors,
		catalog,
		availableTargets = [],
		allowAny = false,
		maxSelectors = MAX_EXTRA_COMPETITION_TRAITS,
		uniqueKeys = false,
		idPrefix,
		label,
		fieldLabel = label,
		help = '',
		disabled,
		onChange
	}: {
		selectors: TradingTraitCompetitionSelector[];
		catalog: ApiTraitCatalogFacet[];
		availableTargets?: ApiTraitFacet[];
		allowAny?: boolean;
		maxSelectors?: number;
		uniqueKeys?: boolean;
		idPrefix: string;
		label: string;
		fieldLabel?: string;
		help?: string;
		disabled: boolean;
		onChange: (selectors: TradingTraitCompetitionSelector[]) => void;
	} = $props();
	function update(index: number, selector: TradingTraitCompetitionSelector): void {
		onChange(selectors.map((entry, position) => (position === index ? selector : entry)));
	}
	function targetUnavailable(key: string, value: string): boolean {
		return (
			availableTargets.find((f) => f.key === key)?.values.find((v) => v.value === value)
				?.marketplaceBiddingSupported === false
		);
	}
</script>

{#snippet selectorLabel()}
	<span class="bootstrap-form-label-cell">
		<span>{fieldLabel}</span>
		<InfoTooltip text={help} className="bootstrap-form-label-tooltip" />
	</span>
{/snippet}

<div class="bidding-trait-selectors" role="group" aria-label={label}>
	{#each selectors as selector, index}
		<div class="bootstrap-form-row">
			{#if index === 0}
				<label for={`${idPrefix}-key-1`}>{@render selectorLabel()}</label>
			{:else}
				<span aria-hidden="true"></span>
			{/if}
			<div class="bidding-trait-selector-row">
				<select
					id={`${idPrefix}-key-${index + 1}`}
					class="bootstrap-control-select"
					aria-label={`${label} key ${index + 1}`}
					title={selector.type}
					value={selector.type}
					{disabled}
					onchange={(event) =>
						update(index, { type: event.currentTarget.value, value: '' })}
				>
					<option value="" disabled>trait</option>
					{#if selector.type && !catalog.some((f) => f.key === selector.type)}
						<option value={selector.type} disabled>{selector.type} (unavailable)</option>
					{/if}
					{#each catalog as facet}
						<option
							value={facet.key}
							disabled={uniqueKeys && selectors.some(
								(entry, position) => position !== index && entry.type === facet.key
							)}
						>
							{facet.key}
						</option>
					{/each}
				</select>
				<select
					class="bootstrap-control-select"
					class:trait-group-active={selector.value === undefined}
					aria-label={`${label} value ${index + 1}`}
					title={selector.value === undefined ? 'any (all values)' : selector.value}
					value={selector.value === undefined ? ANY_VALUE : `${EXACT_VALUE_PREFIX}${selector.value}`}
					disabled={disabled || !selector.type}
					onchange={(event) =>
						update(
							index,
							event.currentTarget.value === ANY_VALUE
								? { type: selector.type }
								: {
										type: selector.type,
										value: event.currentTarget.value.slice(EXACT_VALUE_PREFIX.length)
									}
						)}
				>
					<option value={EXACT_VALUE_PREFIX} disabled>value</option>
					{#if allowAny}
						<option value={ANY_VALUE} class="trait-group-active">{ANY_VALUE_LABEL}</option>
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
							{entry.value.toLowerCase() === 'any' ? JSON.stringify(entry.value) : entry.value}
						</option>
					{/each}
				</select>
				<button
					type="button"
					class="facet-panel-action-button facet-reset-button bid-book-maker-filter-clear"
					aria-label={`remove ${label} ${index + 1}`}
					title={`remove ${label} ${index + 1}`}
					{disabled}
					onclick={() => onChange(selectors.filter((_, i) => i !== index))}
				>
					x
				</button>
			</div>
		</div>
	{/each}
	<div class="bootstrap-form-row">
		{#if selectors.length === 0}
			<label for={`${idPrefix}-key-1`}>{@render selectorLabel()}</label>
		{:else}
			<span aria-hidden="true"></span>
		{/if}
		<button
			type="button"
			class="facet-panel-action-button action-button-positive"
			disabled={disabled || selectors.length >= maxSelectors || catalog.length === 0}
			onclick={() => onChange([...selectors, { type: '', value: '' }])}
		>
			add
		</button>
	</div>
</div>
