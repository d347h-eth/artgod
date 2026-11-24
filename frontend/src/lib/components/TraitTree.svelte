<script lang="ts">
	import { TRAIT_NODE_KIND, type TraitNode } from '@artgod/shared/types/trait-catalog';
	import type { Snippet } from 'svelte';
	import type { TraitLeaf } from '$lib/trait-tree';
	import TraitTree from './TraitTree.svelte';

	const MIN_SEARCHABLE_ENTRIES = 25;

	let {
		nodes,
		leafValue,
		initiallyExpanded = false
	}: { nodes: TraitNode[]; leafValue?: Snippet<[TraitLeaf]>; initiallyExpanded?: boolean } = $props();
	let search = $state('');
	let open = $state<Record<string, boolean>>({});
	const matches = $derived.by(() => {
		const term = search.trim().toLocaleLowerCase();
		return term ? nodes.filter((node) => contains(node, term)) : nodes;
	});
	const fieldsOnly = $derived(nodes.every((node) => node.kind === TRAIT_NODE_KIND.Leaf));

	function contains(node: TraitNode, term: string): boolean {
		if (node.label.toLocaleLowerCase().includes(term)) return true;
		return node.kind === TRAIT_NODE_KIND.Leaf
			? node.value.toLocaleLowerCase().includes(term)
			: node.children.some((child) => contains(child, term));
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

<div class="trait-tree">
	{#if nodes.length >= MIN_SEARCHABLE_ENTRIES}
		<input
			class="trait-search-input"
			aria-label="Search traits"
			placeholder="Search traits"
			bind:value={search}
		/>
	{/if}
	<ul class:field-list={fieldsOnly}>
		{#each matches as node (node.id)}
			<li class:field={node.kind === TRAIT_NODE_KIND.Leaf}>
				{#if node.kind === TRAIT_NODE_KIND.Leaf}
					<dl class="trait-tree-field">
						<dt>{node.label}</dt>
						<dd>
							{#if leafValue}
								{@render leafValue(node)}
							{:else}
								{node.value}
							{/if}
						</dd>
					</dl>
				{:else}
					{@const children = visibleChildren(node)}
					{@const expanded = open[node.id] ?? initiallyExpanded}
					<details
						open={expanded}
						ontoggle={(event) => (open[node.id] = event.currentTarget.open)}
					>
						<summary>
							<span>{node.label}</span>
							{#if children.length > 1 && children.every((child) => child.kind === TRAIT_NODE_KIND.Entity)}
								<span class="trait-tree-count">{children.length}</span>
							{/if}
						</summary>
						{#if expanded}
							<TraitTree nodes={children} {leafValue} />
						{/if}
					</details>
				{/if}
			</li>
		{/each}
	</ul>
	{#if matches.length === 0 && search}
		<p class="muted">No matching traits</p>
	{/if}
</div>

<style>
	.trait-tree {
		min-width: 0;
		font-size: 0.78rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
		word-break: normal;
	}

	ul, dl, dd, p {
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

	details > :global(.trait-tree) {
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

	.trait-search-input {
		width: min(25ch, 100%);
		margin-block: 0.3rem;
	}
</style>
