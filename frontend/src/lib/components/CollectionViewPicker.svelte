<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		selectedCollectionView,
		selectCollectionViewHref,
		type CollectionViewPage
	} from '$lib/collection-view';
	import { joinPath, withQuery } from '$lib/route-paths';

	let {
		context,
		path,
		query,
		initialGroup = null,
		centered = false
	}: {
		context: CollectionViewPage;
		path: string;
		query: URLSearchParams;
		initialGroup?: string | null;
		centered?: boolean;
	} = $props();

	let active = $derived(selectedCollectionView(context));
	let choosingGroup = $state<string | null>(null);
	let groups = $derived([
		...new Map(
			context.discovery.views.map((view) => [view.parent?.id ?? view.id, view.parent ?? view])
		).values()
	]);
	let kind = $derived(choosingGroup ?? initialGroup ?? active?.parent?.id ?? active?.id ?? '');
	let leaves = $derived(context.discovery.views.filter((view) => view.parent?.id === kind));

	function chooseKind(id: string): void {
		const leaf = context.discovery.views.find((view) => view.id === id && !view.parent);
		if (leaf) {
			void goto(selectCollectionViewHref(path, query, leaf));
		} else if (active) {
			void goto(
				withQuery(
					joinPath(context.basePath, 'views'),
					new URLSearchParams({ group: id, section: path })
				)
			);
		} else {
			choosingGroup = id;
		}
	}

	function chooseLeaf(id: string): void {
		const leaf = leaves.find((view) => view.id === id);
		if (leaf) void goto(selectCollectionViewHref(path, query, leaf));
	}
</script>

<div class="collection-view-picker" class:centered>
	<label>
		Token kind
		<select
			class="bootstrap-control"
			value={kind}
			onchange={(event) => chooseKind(event.currentTarget.value)}
		>
			<option value="" disabled>Choose kind</option>
			{#each groups as group (group.id)}
				<option value={group.id}>{group.label}</option>
			{/each}
		</select>
	</label>
	{#if leaves.length}
		<label>
			Collection block
			<select
				class="bootstrap-control"
				title={active?.parent?.id === kind ? active.label : undefined}
				value={leaves.some((leaf) => leaf.id === active?.id) ? active?.id : ''}
				onchange={(event) => chooseLeaf(event.currentTarget.value)}
			>
				<option value="" disabled>Choose block</option>
				{#each leaves as leaf (leaf.id)}
					<option value={leaf.id}>{leaf.label}</option>
				{/each}
			</select>
		</label>
	{/if}
	{#if active}
		{#each active.pinnedTraits as trait}
			<span class="mono">{trait.key} = {trait.value}</span>
		{/each}
		{#if active.ready < active.classified}
			<span class="muted">Traits ready for {active.ready} of {active.classified} NFTs</span>
		{/if}
		{#if active.failed}
			<span role="status">
				Trait processing failed for {active.failed} {active.failed === 1 ? 'NFT' : 'NFTs'}
			</span>
		{/if}
	{:else if groups.length === 0}
		<span class="muted">Waiting for indexed token traits.</span>
	{/if}
</div>

<style>
	.collection-view-picker,
	label {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		max-width: 100%;
	}

	.collection-view-picker {
		gap: 0.75rem;
		overflow-wrap: anywhere;
	}

	.centered {
		width: fit-content;
		max-width: calc(100% - 2 * var(--panel-content-padding));
		margin: 0.75rem auto;
	}

	select {
		min-width: 0;
		max-width: min(24rem, 100%);
		text-overflow: ellipsis;
	}
</style>
