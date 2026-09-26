<script lang="ts">
	import type { TradingTraitCompetitionSelector } from '@artgod/shared/types';
	import { MAX_EXTRA_COMPETITION_TRAITS } from '@artgod/shared/trading/trait-competition';

	const VALUE_MODE = { All: 'all', Exact: 'exact' } as const;
	let { selectors, disabled, onChange }: {
		selectors: TradingTraitCompetitionSelector[];
		disabled: boolean;
		onChange: (selectors: TradingTraitCompetitionSelector[]) => void;
	} = $props();

	function update(index: number, selector: TradingTraitCompetitionSelector): void {
		onChange(selectors.map((entry, position) => position === index ? selector : entry));
	}
</script>

<section class="competition-editor" aria-label="extra single-trait competitors">
	<div class="competition-heading">
		<span class="runtime-k">extra single-trait competitors</span>
		<button
			type="button"
			class="action-button-positive"
			disabled={disabled || selectors.length >= MAX_EXTRA_COMPETITION_TRAITS}
			onclick={() => onChange([...selectors, { type: '' }])}
		>add</button>
	</div>
	{#each selectors as selector, index}
		<div class="competition-entry">
			<div class="competition-fields">
				<input
					class="bootstrap-control"
					type="text"
					aria-label={`competitor trait key ${index + 1}`}
					placeholder="trait key"
					value={selector.type}
					{disabled}
					oninput={(event) => update(index, { ...selector, type: event.currentTarget.value })}
				/>
				<select
					class="bootstrap-control"
					aria-label={`competitor trait values ${index + 1}`}
					{disabled}
					value={selector.value === undefined ? VALUE_MODE.All : VALUE_MODE.Exact}
					onchange={(event) => update(index, event.currentTarget.value === VALUE_MODE.All
						? { type: selector.type }
						: { type: selector.type, value: '' })}
				>
					<option value={VALUE_MODE.All}>all values</option>
					<option value={VALUE_MODE.Exact}>exact value</option>
				</select>
			</div>
			<div class="competition-fields">
				<button
					type="button"
					class="action-button-negative"
					aria-label={`remove competitor trait ${index + 1}`}
					{disabled}
					onclick={() => onChange(selectors.filter((_, position) => position !== index))}
				>remove</button>
				{#if selector.value !== undefined}
					<input
						class="bootstrap-control"
						type="text"
						aria-label={`competitor trait value ${index + 1}`}
						placeholder="trait value"
						value={selector.value}
						{disabled}
						oninput={(event) => update(index, { type: selector.type, value: event.currentTarget.value })}
					/>
				{/if}
			</div>
		</div>
	{/each}
</section>

<style>
	.competition-editor {
		display: grid;
		gap: 0.65rem;
		min-width: 0;
	}
	.competition-heading {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.competition-entry {
		display: grid;
		gap: 0.3rem;
	}
	.competition-fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 0.5rem;
		align-items: center;
	}
	.competition-fields > button {
		justify-self: start;
	}
	.competition-fields > input,
	.competition-fields > select {
		min-width: 0;
	}
</style>
