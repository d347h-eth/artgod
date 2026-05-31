<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
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
		sortButtonClassName: string;
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
		sortButtonClassName,
		formatSortLabel,
		resolveAriaSort,
		onSort,
		children
	}: TerraformsTraitTableProps = $props();
</script>

<div class={TERRAFORMS_TRAIT_TABLE_DOM.classes.wrapper}>
	<table class={className} data-testid={testId}>
		<thead>
			<tr>
				{#each columns as column}
					<th aria-sort={resolveAriaSort(column, activeColumn, sortDirection)}>
						<button
							type={TERRAFORMS_TRAIT_TABLE_BUTTON_TYPES.Button}
							class={sortButtonClassName}
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
