<script lang="ts">
	import { TRAIT_NODE_KIND, type TraitNode } from '@artgod/shared/types/trait-catalog';
	import { SvelteMap } from 'svelte/reactivity';
	import type { TraitLeaf } from '$lib/trait-tree';

	let { nodes }: { nodes: TraitNode[] } = $props();

	// Before the first bulk action, only top-level groups start open.
	let bulkExpansion = $state<boolean | null>(null);
	// IDs are local to their branch. Keep a manual toggle scoped to its full path.
	const manualExpansion = new SvelteMap<string, boolean>();
	const allExpanded = $derived(!hasCollapsedBranch(nodes, []));

	function isExpanded(path: string[]): boolean {
		return (
			manualExpansion.get(JSON.stringify(path)) ?? bulkExpansion ?? (path.length === 1)
		);
	}

	function hasCollapsedBranch(items: TraitNode[], parent: string[]): boolean {
		return items.some((node) => {
			if (node.kind === TRAIT_NODE_KIND.Leaf) return false;
			const path = [...parent, node.id];
			return !isExpanded(path) || hasCollapsedBranch(visibleChildren(node), path);
		});
	}

	function toggleAll(): void {
		bulkExpansion = !allExpanded;
		manualExpansion.clear();
	}

	function visibleChildren(node: Exclude<TraitNode, TraitLeaf>): TraitNode[] {
		const [onlyChild] = node.children;
		if (
			node.kind === TRAIT_NODE_KIND.Group &&
			node.children.length === 1 &&
			onlyChild.kind === TRAIT_NODE_KIND.Entity &&
			onlyChild.label === node.label
		) {
			return onlyChild.children;
		}
		return node.children;
	}
</script>

{#snippet list(items: TraitNode[], parent: string[])}
	<ul class:field-list={items.every((node) => node.kind === TRAIT_NODE_KIND.Leaf)}>
		{#each items as node (node.id)}
			<li class:field={node.kind === TRAIT_NODE_KIND.Leaf}>
				{#if node.kind === TRAIT_NODE_KIND.Leaf}
					<dl class="trait-tree-field">
						<dt>{node.label}</dt>
						<dd>{node.value}</dd>
					</dl>
				{:else}
					{@const children = visibleChildren(node)}
					{@const path = [...parent, node.id]}
					{@const expanded = isExpanded(path)}
					<details
						open={expanded}
						ontoggle={(event) => {
							const open = event.currentTarget.open;
							if (open !== expanded) manualExpansion.set(JSON.stringify(path), open);
						}}
					>
						<summary>
							<span>{node.label}</span>
							{#if children.length > 1 && children.every((child) => child.kind === TRAIT_NODE_KIND.Entity)}
								<span class="trait-tree-count">{children.length}</span>
							{/if}
						</summary>
						{#if expanded}
							<div class="trait-tree">{@render list(children, path)}</div>
						{/if}
					</details>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

<div class="trait-tree">
	{#if nodes.some((node) => node.kind !== TRAIT_NODE_KIND.Leaf)}
		<button
			type="button"
			class="facet-panel-action-button"
			class:facet-collapse-button-active={allExpanded}
			aria-expanded={allExpanded}
			onclick={toggleAll}
		>
			{allExpanded ? 'Collapse all' : 'Expand all'}
		</button>
	{/if}
	{@render list(nodes, [])}
</div>

<style>
	.trait-tree {
		min-width: 0;
		font-size: 0.78rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
		word-break: normal;
	}

	ul, dl, dd {
		margin: 0;
	}

	ul {
		display: grid;
		grid-template-columns: fit-content(44%) minmax(0, 1fr);
		column-gap: 1rem;
		list-style: none;
		padding: 0;
	}

	li {
		grid-column: 1 / -1;
		min-width: 0;
	}

	.field,
	.trait-tree-field {
		display: grid;
		grid-template-columns: subgrid;
	}

	/* Cap label tracks against the available section, including when the tree centers at its intrinsic width. */
	@container token-detail-traits (min-width: 0px) {
		ul {
			grid-template-columns: fit-content(44cqi) minmax(0, 1fr);
		}
	}

	@container token-detail-traits (min-width: 68rem) {
		.field-list:has(> :nth-child(8)) {
			grid-template-columns: repeat(2, fit-content(23cqi) minmax(0, 1fr));
			column-gap: 1.25rem;
		}

		.field-list:has(> :nth-child(8)) > .field {
			grid-column: span 2;
		}
	}

	summary {
		cursor: pointer;
		padding: 0.2rem 0;
		color: var(--c-cyan);
	}

	summary:hover, summary:focus-visible {
		color: var(--c-yellow);
	}

	.trait-tree-count {
		margin-inline-start: 0.5ch;
		color: var(--c-sand);
		font-variant-numeric: tabular-nums;
	}

	details > .trait-tree {
		border-inline-start: 1px solid var(--c-blue);
		margin-inline-start: 0.25rem;
		padding-inline-start: 0.65rem;
	}

	.trait-tree-field {
		grid-column: 1 / -1;
		padding-block: 0.25rem;
	}

	dt {
		color: var(--c-sand);
	}

	dd {
		color: var(--c-ice);
	}

	.facet-panel-action-button {
		display: flex;
		width: fit-content;
		margin-inline: auto;
		margin-block-end: var(--control-button-gap);
	}
</style>
