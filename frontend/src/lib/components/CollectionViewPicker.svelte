<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { compareTraitLabels } from '$lib/trait-facet-sorting';
	import {
		selectedCollectionView,
		selectCollectionViewHref,
		type CollectionViewPage
	} from '$lib/collection-view';

	let {
		context,
		path,
		query
	}: {
		context: CollectionViewPage;
		path: string;
		query: URLSearchParams;
	} = $props();

	let active = $derived(selectedCollectionView(context));
	let groups = $derived([
		{ id: null, label: 'All', scope: null },
		...new Map(
			context.discovery.views.map((view) => [
				view.parent?.id ?? view.id,
				{
					id: view.parent?.id ?? view.id,
					label: view.parent?.label ?? view.label,
					scope: view.parent ? { groupId: view.parent.id } : view
				}
			])
		).values()
	]);
	let kind = $derived(active?.parent?.id ?? active?.id ?? context.discovery.selectedGroupId ?? null);
	let leaves = $derived(
		context.discovery.views
			.filter((view) => view.parent && view.parent.id === kind)
			.sort((left, right) => compareTraitLabels(left.label, right.label))
	);
	let refreshing = $state(false);

	async function refreshViews(): Promise<void> {
		if (refreshing) return;
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}

	// A scope change remounts the results. Return keyboard focus to the
	// replacement select so another arrow-key choice starts from the same place.
	const blockSelectId = 'collection-view-block';
	async function chooseLeaf(select: HTMLSelectElement): Promise<void> {
		if (!kind) return;
		const value = select.value;
		const scope = value ? leaves.find((view) => view.id === value) : { groupId: kind };
		if (!scope) return;
		const hadFocus = document.activeElement === select;
		await goto(selectCollectionViewHref(path, query, scope), { reset: false });
		const replacement = document.getElementById(blockSelectId);
		if (hadFocus && replacement instanceof HTMLSelectElement && replacement.value === value) {
			replacement.focus({ preventScroll: true });
		}
	}
</script>

<div class="panel-top-actions-row collection-view-picker">
	<div class="secondary-tabs" role="group" aria-label="Token kind">
		{#each groups as group (group.id)}
			{#if group.id === kind}
				<span class="secondary-tab-active" aria-current="true">{group.label}</span>
			{:else}
				<a href={selectCollectionViewHref(path, query, group.scope)}>{group.label}</a>
			{/if}
		{/each}
	</div>
	{#if leaves.length}
		<label>
			<span class="panel-top-actions-label">Block</span>
			<select
				class="facet-panel-action-button"
				id={blockSelectId}
				aria-label="Collection block"
				title={active?.label}
				value={active?.id ?? ''}
				onchange={(event) => void chooseLeaf(event.currentTarget)}
			>
				<option value="">All blocks</option>
				{#each leaves as leaf (leaf.id)}
					<option value={leaf.id}>{leaf.label}</option>
				{/each}
			</select>
		</label>
	{/if}
	{#if !context.discovery.views.length}
		<div class="panel-top-actions-row">
			<span class="muted">Waiting for token traits.</span>
			<button
				type="button"
				class="facet-panel-action-button"
				disabled={refreshing}
				onclick={refreshViews}
			>
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</div>
	{/if}
	{#if active && active.ready < active.classified}
		<span class="muted">Traits ready for {active.ready} of {active.classified} NFTs</span>
	{/if}
	{#if active?.failed}
		<span role="status">Trait processing failed for {active.failed} {active.failed === 1 ? 'NFT' : 'NFTs'}</span>
	{/if}
</div>

<style>
	.collection-view-picker {
		font-size: 0.72rem;
		gap: 0.65rem 1.5rem;
		padding: var(--control-button-gap) var(--panel-content-padding);
	}

	label {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--control-button-gap);
		max-width: 100%;
		min-width: 0;
	}

	label::after {
		content: '';
		position: absolute;
		right: 0.48rem;
		width: 0.31rem;
		height: 0.31rem;
		border: solid var(--c-cyan);
		border-width: 0 1px 1px 0;
		transform: translateY(-0.08rem) rotate(45deg);
		pointer-events: none;
	}

	label:focus-within::after,
	label:hover::after {
		border-color: var(--c-yellow);
	}

	select {
		appearance: none;
		padding-right: 1.4rem;
		min-width: 0;
		width: 30ch;
		text-overflow: ellipsis;
		text-transform: none;
	}
</style>
