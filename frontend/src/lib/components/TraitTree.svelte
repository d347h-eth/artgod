<script lang="ts">
	import { TRAIT_NODE_KIND, type TraitNode } from '@artgod/shared/types/trait-catalog';
	import TraitTree from './TraitTree.svelte';

	const PAGE_SIZE = 24;

	let { nodes }: { nodes: TraitNode[] } = $props();
	let offset = $state(0);
	let search = $state('');
	let open = $state<Record<string, boolean>>({});
	let matches = $derived.by(() => {
		const term = search.trim().toLocaleLowerCase();
		return term ? nodes.filter((node) => contains(node, term)) : nodes;
	});

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
</script>

{#if nodes.length > PAGE_SIZE}
	<input
		class="collection-jump-input"
		aria-label="Search traits"
		placeholder="Search traits"
		value={search}
		oninput={(event) => searchTraits(event.currentTarget.value)}
	/>
{/if}
<ul class="trait-tree">
	{#each matches.slice(offset, offset + PAGE_SIZE) as node (node.id)}
		<li>
			{#if node.kind === TRAIT_NODE_KIND.Leaf}
				{node.label} <span class="mono">{node.value}</span>
			{:else}
				<details ontoggle={(event) => (open[node.id] = event.currentTarget.open)}>
					<summary>{node.label}</summary>
					{#if open[node.id]}
						<TraitTree nodes={node.children} />
					{/if}
				</details>
			{/if}
		</li>
	{/each}
</ul>
{#if matches.length === 0 && search}
	<span class="muted">No matching traits</span>
{/if}
{#if matches.length > PAGE_SIZE}
	<div>
		<button
			type="button"
			class="bootstrap-control"
			disabled={offset === 0}
			onclick={() => (offset -= PAGE_SIZE)}
		>
			Previous
		</button>
		<span>{offset + 1}–{Math.min(matches.length, offset + PAGE_SIZE)} of {matches.length}</span>
		<button
			type="button"
			class="bootstrap-control"
			disabled={offset + PAGE_SIZE >= matches.length}
			onclick={() => (offset += PAGE_SIZE)}
		>
			Next
		</button>
	</div>
{/if}

<style>
	.trait-tree {
		list-style: none;
		padding-inline-start: 1em;
	}

	summary {
		cursor: pointer;
	}
</style>
