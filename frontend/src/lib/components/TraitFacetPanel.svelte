<script lang="ts">
	import { tick } from 'svelte';
	import type {
		ApiTokenAttribute,
		ApiTraitFacet,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import {
		sortTraitFacetValues,
		type TraitFacetValueSortMode
	} from '$lib/trait-facet-sorting';

	type MaybePromise<T> = T | Promise<T>;
	type TraitRangeDraft = {
		fromValue: string;
		toValue: string;
	};

	let {
		facets,
		selectedTraits,
		selectedRanges,
		collapsed = false,
		sticky = true,
		onToggleTrait,
		onApplyTraitRange
	}: {
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedRanges: ApiTraitRangeFilter[];
		collapsed?: boolean;
		sticky?: boolean;
		onToggleTrait: (
			key: string,
			value: string,
			checked: boolean,
			exclusiveMode: boolean
		) => MaybePromise<void>;
		onApplyTraitRange: (
			key: string,
			fromValue: string | null,
			toValue: string | null
		) => MaybePromise<void>;
	} = $props();

	let traitValueSearch = $state<Record<string, string>>({});
	let traitValueSortMode = $state<Record<string, TraitFacetValueSortMode>>({});
	let traitRangeDrafts = $state<Record<string, TraitRangeDraft>>({});
	const traitSearchInputs = new Map<string, HTMLInputElement>();
	let activeTraitSet = $derived(new Set(selectedTraits.map((item) => `${item.key}:${item.value}`)));
	let activeRangeMap = $derived(
		new Map(selectedRanges.map((item) => [item.key, { fromValue: item.fromValue, toValue: item.toValue }]))
	);

	$effect(() => {
		const nextDrafts: Record<string, TraitRangeDraft> = {};
		for (const range of selectedRanges) {
			nextDrafts[range.key] = {
				fromValue: range.fromValue ?? '',
				toValue: range.toValue ?? ''
			};
		}
		traitRangeDrafts = nextDrafts;
	});

	function traitId(key: string, value: string): string {
		return `${key}-${value}`.replace(/\s+/g, '-').toLowerCase();
	}

	function traitChecked(key: string, value: string): boolean {
		return activeTraitSet.has(`${key}:${value}`);
	}

	function onTraitSearchInput(key: string, event: Event): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;

		traitValueSearch = {
			...traitValueSearch,
			[key]: target.value
		};
	}

	function traitSearchValue(key: string): string {
		return traitValueSearch[key] ?? '';
	}

	function registerTraitSearchInput(node: HTMLInputElement, key: string): { destroy(): void } {
		traitSearchInputs.set(key, node);
		return {
			destroy() {
				if (traitSearchInputs.get(key) === node) {
					traitSearchInputs.delete(key);
				}
			}
		};
	}

	function onTraitGroupToggle(facet: ApiTraitFacet, event: Event): void {
		const details = event.currentTarget as HTMLDetailsElement | null;
		if (!details?.open || facet.displayKind === 'range') return;
		void focusTraitSearchInput(facet.key);
	}

	async function focusTraitSearchInput(key: string): Promise<void> {
		await tick();
		traitSearchInputs.get(key)?.focus();
	}

	function traitSortMode(key: string): TraitFacetValueSortMode {
		return traitValueSortMode[key] ?? 'rarity';
	}

	function traitSortModeLabel(key: string): 'R' | 'A' {
		return traitSortMode(key) === 'alpha' ? 'A' : 'R';
	}

	function traitSortModeTitle(key: string): string {
		return traitSortMode(key) === 'alpha' ? 'sort alpha-numeric' : 'sort by rarity';
	}

	function toggleTraitSortMode(key: string): void {
		traitValueSortMode = {
			...traitValueSortMode,
			[key]: traitSortMode(key) === 'alpha' ? 'rarity' : 'alpha'
		};
	}

	function traitValueMatches(key: string, value: string): boolean {
		const pattern = traitSearchValue(key).trim().toLowerCase();
		if (!pattern) return true;

		const haystack = value.toLowerCase();
		if (!pattern.includes('*')) {
			return haystack.includes(pattern);
		}

		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
		return new RegExp(`^${escaped}$`).test(haystack);
	}

	function visibleFacetValues(facet: ApiTraitFacet): Array<{ value: string; tokenCount: number }> {
		return sortTraitFacetValues(
			facet.values.filter((item) => traitValueMatches(facet.key, item.value)),
			traitSortMode(facet.key)
		);
	}

	function traitGroupActive(key: string): boolean {
		return (
			selectedTraits.some((item) => item.key === key) ||
			selectedRanges.some((item) => item.key === key)
		);
	}

	function onTraitCheckboxClick(key: string, value: string, event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		void onToggleTrait(key, value, target.checked, event.ctrlKey);
	}

	function rangeDraft(key: string): TraitRangeDraft {
		return traitRangeDrafts[key] ?? { fromValue: '', toValue: '' };
	}

	function onRangeDraftInput(key: string, bound: 'fromValue' | 'toValue', event: Event): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		const sanitized = target.value.replace(/[^\d]/g, '');
		updateRangeDraft(key, bound, sanitized);
	}

	function updateRangeDraft(
		key: string,
		bound: 'fromValue' | 'toValue',
		value: string
	): void {
		traitRangeDrafts = {
			...traitRangeDrafts,
			[key]: {
				...rangeDraft(key),
				[bound]: value
			}
		};
	}

	function hasNumericBounds(facet: ApiTraitFacet): boolean {
		return facet.minValue !== null || facet.maxValue !== null;
	}

	function hasActiveRange(key: string): boolean {
		return activeRangeMap.has(key);
	}

	function rangeControlsDisabled(facet: ApiTraitFacet): boolean {
		return !hasNumericBounds(facet) && !hasActiveRange(facet.key);
	}

	function rangeHint(facet: ApiTraitFacet): string {
		const minLabel = facet.minValue ?? '-';
		const maxLabel = facet.maxValue ?? '-';
		return `min ${minLabel} / max ${maxLabel}`;
	}

	function onRangeHintValueClick(
		key: string,
		bound: 'fromValue' | 'toValue',
		value: string | null
	): void {
		if (!value) return;
		updateRangeDraft(key, bound, value);
	}

	function onRangeApplyClick(key: string): void {
		const draft = rangeDraft(key);
		void onApplyTraitRange(key, draft.fromValue || null, draft.toValue || null);
	}

	function onRangeClearClick(key: string): void {
		traitRangeDrafts = {
			...traitRangeDrafts,
			[key]: {
				fromValue: '',
				toValue: ''
			}
		};
		void onApplyTraitRange(key, null, null);
	}

	function onRangeInputKeydown(key: string, event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		onRangeApplyClick(key);
	}
</script>

<div class="facet-column" class:facet-column-sticky={sticky && !collapsed}>
	{#if !collapsed}
		<aside class="facet-panel">
			<div class="facet-header">
				<h2>traits</h2>
			</div>

			{#if facets.length === 0}
				<p class="muted">no trait facets yet</p>
			{:else}
				{#each facets as facet}
					<details class="trait-group" ontoggle={(event) => onTraitGroupToggle(facet, event)}>
						<summary>
							<span class:trait-group-active={traitGroupActive(facet.key)}>{facet.key}</span>
							<span class="muted">{facet.values.length}</span>
						</summary>

						<div class="trait-group-body">
							{#if facet.displayKind === 'range'}
								<div class="trait-range-group">
									<div class="mono muted trait-range-hint">
										<span>min </span>
										{#if facet.minValue !== null}
											<button
												type="button"
												class="trait-range-hint-button"
												onclick={() =>
													onRangeHintValueClick(facet.key, 'fromValue', facet.minValue)}
											>
												{facet.minValue}
											</button>
										{:else}
											<span>-</span>
										{/if}
										<span> / max </span>
										{#if facet.maxValue !== null}
											<button
												type="button"
												class="trait-range-hint-button"
												onclick={() =>
													onRangeHintValueClick(facet.key, 'toValue', facet.maxValue)}
											>
												{facet.maxValue}
											</button>
										{:else}
											<span>-</span>
										{/if}
									</div>
									{#if rangeControlsDisabled(facet)}
										<p class="muted">no numeric values available</p>
									{/if}
									<div class="trait-range-inputs">
										<label class="trait-range-field">
											<span class="muted">from</span>
											<input
												class="trait-range-input"
												type="text"
												inputmode="numeric"
												placeholder={facet.minValue ?? 'min'}
												value={rangeDraft(facet.key).fromValue}
												disabled={rangeControlsDisabled(facet)}
												oninput={(event) => onRangeDraftInput(facet.key, 'fromValue', event)}
												onkeydown={(event) => onRangeInputKeydown(facet.key, event)}
											/>
										</label>
										<label class="trait-range-field">
											<span class="muted">to</span>
											<input
												class="trait-range-input"
												type="text"
												inputmode="numeric"
												placeholder={facet.maxValue ?? 'max'}
												value={rangeDraft(facet.key).toValue}
												disabled={rangeControlsDisabled(facet)}
												oninput={(event) => onRangeDraftInput(facet.key, 'toValue', event)}
												onkeydown={(event) => onRangeInputKeydown(facet.key, event)}
											/>
										</label>
									</div>
									<div class="trait-range-actions">
										<button
											type="button"
											class="facet-panel-action-button trait-range-action-button"
											disabled={rangeControlsDisabled(facet)}
											onclick={() => onRangeApplyClick(facet.key)}
										>
											apply
										</button>
										<button
											type="button"
											class="facet-panel-action-button trait-range-action-button"
											disabled={!hasActiveRange(facet.key)}
											onclick={() => onRangeClearClick(facet.key)}
										>
											clear
										</button>
									</div>
								</div>
							{:else}
								<div class="trait-search-row">
									<input
										class="trait-search-input"
										type="search"
										placeholder="search"
										value={traitSearchValue(facet.key)}
										use:registerTraitSearchInput={facet.key}
										oninput={(event) => onTraitSearchInput(facet.key, event)}
									/>
									<button
										type="button"
										class="facet-panel-action-button trait-sort-button"
										title={traitSortModeTitle(facet.key)}
										aria-label={traitSortModeTitle(facet.key)}
										onclick={() => toggleTraitSortMode(facet.key)}
									>
										{traitSortModeLabel(facet.key)}
									</button>
								</div>

								<div class="trait-values">
									{#if visibleFacetValues(facet).length === 0}
										<p class="muted">no matches</p>
									{:else}
										{#each visibleFacetValues(facet) as value}
											<label for={traitId(facet.key, value.value)}>
												<input
													id={traitId(facet.key, value.value)}
													type="checkbox"
													checked={traitChecked(facet.key, value.value)}
													onclick={(event) =>
														onTraitCheckboxClick(facet.key, value.value, event)}
												/>
												<span class="trait-value-text">{value.value}</span>
												<span class="trait-value-count mono">{value.tokenCount}</span>
											</label>
										{/each}
									{/if}
								</div>
							{/if}
						</div>
					</details>
				{/each}
			{/if}
		</aside>
	{/if}
</div>
