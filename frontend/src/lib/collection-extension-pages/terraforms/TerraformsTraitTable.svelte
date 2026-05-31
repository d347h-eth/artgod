<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES,
		TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES,
		TERRAFORMS_TRAIT_TABLE_DOM,
		type TerraformsTraitTableAriaSortValue,
		type TerraformsTraitTableSortDirection
	} from '$lib/collection-extension-pages/terraforms/trait-table';

	type TerraformsTraitTableProps = {
		columns: readonly string[];
		labels: Readonly<Record<string, string>>;
		activeColumn: string;
		sortDirection: TerraformsTraitTableSortDirection;
		className: string;
		testId: string;
		formatSortLabel: (column: string) => string;
		resolveAriaSort: (
			column: string,
			activeColumn: string,
			direction: TerraformsTraitTableSortDirection
		) => TerraformsTraitTableAriaSortValue;
		onSort: (column: string) => void;
		children: Snippet;
	};

	let {
		columns,
		labels,
		activeColumn,
		sortDirection,
		className,
		testId,
		formatSortLabel,
		resolveAriaSort,
		onSort,
		children
	}: TerraformsTraitTableProps = $props();

	function sortHeaderClassName(ariaSort: TerraformsTraitTableAriaSortValue): string {
		const classNames: string[] = [TERRAFORMS_TRAIT_TABLE_DOM.classes.sortHeader];
		if (ariaSort !== TERRAFORMS_TRAIT_TABLE_ARIA_SORT_VALUES.None) {
			classNames.push(TERRAFORMS_TRAIT_TABLE_DOM.classes.sortHeaderActive);
		}
		return classNames.join(' ');
	}
</script>

<div class={TERRAFORMS_TRAIT_TABLE_DOM.classes.wrapper}>
	<table class={className} data-testid={testId}>
		<thead>
			<tr>
				{#each columns as column}
					{@const ariaSort = resolveAriaSort(column, activeColumn, sortDirection)}
					<th class={sortHeaderClassName(ariaSort)} aria-sort={ariaSort}>
						<button
							type={TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES.Button}
							class={TERRAFORMS_TRAIT_TABLE_DOM.classes.sortButton}
							aria-label={formatSortLabel(column)}
							onclick={() => onSort(column)}
						>
							<span>{labels[column]}</span>
						</button>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{@render children()}
		</tbody>
	</table>
</div>

<style>
	:global(.terraforms-trait-table-sort-header .activities-time-mode-button) {
		color: inherit;
	}

	:global(.terraforms-trait-table-sort-header-active) {
		color: var(--c-orange);
	}

	:global(.terraforms-trait-table-sort-header .activities-time-mode-button:hover),
	:global(.terraforms-trait-table-sort-header .activities-time-mode-button:focus-visible) {
		color: var(--c-yellow);
		outline: none;
	}
</style>
