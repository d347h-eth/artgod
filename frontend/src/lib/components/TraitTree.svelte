<script lang="ts">
	import { TRAIT_NODE_KIND, type TraitNode } from '@artgod/shared/types/trait-catalog';
	import type { Snippet } from 'svelte';
	import type { TraitLeaf } from '$lib/trait-tree';
	import TraitTree from './TraitTree.svelte';

	const PAGE_SIZE = 24;

	let { nodes, leafValue }: { nodes: TraitNode[]; leafValue?: Snippet<[TraitLeaf]> } = $props();
	let offset = $state(0);
	let search = $state('');
	let open = $state<Record<string, boolean>>({});
	const matches = $derived.by(() => {
		const term = search.trim().toLocaleLowerCase();
		return term ? nodes.filter((node) => contains(node, term)) : nodes;
	});
	const pageStart = $derived(
		Math.min(offset, Math.floor(Math.max(0, matches.length - 1) / PAGE_SIZE) * PAGE_SIZE)
	);

	function contains(node: TraitNode, term: string): boolean {
		if (node.label.toLocaleLowerCase().includes(term)) return true;
		return node.kind === TRAIT_NODE_KIND.Leaf
			? node.value.toLocaleLowerCase().includes(term)
			: node.children.some((child) => contains(child, term));
	}

	function searchTraits(value: string): void {
		search = value;
		offset = 0;
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
	{#if nodes.length > PAGE_SIZE}
		<input
			class="trait-search-input"
			aria-label="Search traits"
			placeholder="Search traits"
			value={search}
			oninput={(event) => searchTraits(event.currentTarget.value)}
		/>
	{/if}
	<ul>
		{#each matches.slice(pageStart, pageStart + PAGE_SIZE) as node (node.id)}
			<li>
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
					<details
						open={open[node.id] === true}
						ontoggle={(event) => (open[node.id] = event.currentTarget.open)}
					>
						<summary>
							<span>{node.label}</span>
							{#if children.length > 1 && children.every((child) => child.kind === TRAIT_NODE_KIND.Entity)}
								<span class="trait-tree-count">{children.length}</span>
							{/if}
						</summary>
						{#if open[node.id]}
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
	{#if matches.length > PAGE_SIZE}
		<div class="pagination-summary">
			<button
				type="button"
				class="button-link"
				disabled={pageStart === 0}
				onclick={() => (offset = pageStart - PAGE_SIZE)}
			>
				Previous
			</button>
			<span>{pageStart + 1}–{Math.min(matches.length, pageStart + PAGE_SIZE)} of {matches.length}</span>
			<button
				type="button"
				class="button-link"
				disabled={pageStart + PAGE_SIZE >= matches.length}
				onclick={() => (offset = pageStart + PAGE_SIZE)}
			>
				Next
			</button>
		</div>
	{/if}
</div>

<style>
	.trait-tree {
		min-width: 0;
		font-size: 0.78rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
		word-break: normal;
	}

	ul, dl, dd, p {
		margin: 0;
	}

	ul {
		list-style: none;
		padding: 0;
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
		display: grid;
		grid-template-columns: minmax(0, min(13ch, 42%)) minmax(0, 1fr);
		gap: 0.6rem;
		padding: 0.16rem 0;
	}

	dt, .pagination-summary {
		color: var(--c-sand);
	}

	dd {
		color: var(--c-ice);
	}

	.trait-search-input {
		width: min(25ch, 100%);
		margin-block: 0.3rem;
	}

	.pagination-summary {
		gap: 0.4rem;
		margin-block: 0.35rem;
	}
</style>
