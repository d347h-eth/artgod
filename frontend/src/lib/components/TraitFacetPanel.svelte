<script lang="ts">
	import type { ApiTokenAttribute, ApiTraitFacet } from '$lib/api-types';

	type MaybePromise<T> = T | Promise<T>;

	let {
		facets,
		selectedTraits,
		collapsed = false,
		sticky = true,
		onToggleTrait
	}: {
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		collapsed?: boolean;
		sticky?: boolean;
		onToggleTrait: (
			key: string,
			value: string,
			checked: boolean,
			unionMode: boolean
		) => MaybePromise<void>;
	} = $props();

	let traitValueSearch = $state<Record<string, string>>({});
	let activeTraitSet = $derived(new Set(selectedTraits.map((item) => `${item.key}:${item.value}`)));

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
		return facet.values.filter((item) => traitValueMatches(facet.key, item.value));
	}

	function traitGroupActive(key: string): boolean {
		return selectedTraits.some((item) => item.key === key);
	}

	function onTraitCheckboxClick(key: string, value: string, event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		void onToggleTrait(key, value, target.checked, event.ctrlKey);
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
					<details class="trait-group">
						<summary>
							<span class:trait-group-active={traitGroupActive(facet.key)}>{facet.key}</span>
							<span class="muted">{facet.values.length}</span>
						</summary>

						<div class="trait-group-body">
							<input
								class="trait-search-input"
								type="search"
								placeholder="search"
								value={traitSearchValue(facet.key)}
								oninput={(event) => onTraitSearchInput(facet.key, event)}
							/>

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
						</div>
					</details>
				{/each}
			{/if}
		</aside>
	{/if}
</div>
