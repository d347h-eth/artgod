<script lang="ts">
	import { goto } from '$app/navigation';
	import { compareTraitLabels } from '$lib/trait-facet-sorting';
	import {
		collectionViewPickerHref,
		selectedCollectionView,
		selectCollectionViewHref,
		type CollectionViewPage
	} from '$lib/collection-view';

	let {
		context,
		path,
		query,
		initialGroup = null
	}: {
		context: CollectionViewPage;
		path: string;
		query: URLSearchParams;
		initialGroup?: string | null;
	} = $props();

	let active = $derived(selectedCollectionView(context));
	let groups = $derived([
		...new Map(
			context.discovery.views.map((view) => [
				view.parent?.id ?? view.id,
				{
					id: view.parent?.id ?? view.id,
					label: view.parent?.label ?? view.label,
					href: view.parent
						? collectionViewPickerHref(context.basePath, path, query, view.parent.id)
						: selectCollectionViewHref(path, query, view)
				}
			])
		).values()
	]);
	let kind = $derived(active?.parent?.id ?? active?.id ?? initialGroup);
	let leaves = $derived(
		context.discovery.views
			.filter((view) => view.parent && view.parent.id === kind)
			.sort((left, right) => compareTraitLabels(left.label, right.label))
	);

	// A scope change remounts the results. Return keyboard focus to the
	// replacement select so another arrow-key choice starts from the same place.
	const blockSelectId = 'collection-view-block';
	async function chooseLeaf(select: HTMLSelectElement): Promise<void> {
		const leaf = leaves.find((view) => view.id === select.value);
		if (!leaf) return;
		const hadFocus = document.activeElement === select;
		await goto(selectCollectionViewHref(path, query, leaf), { reset: false });
		const replacement = document.getElementById(blockSelectId);
		if (hadFocus && replacement instanceof HTMLSelectElement && replacement.value === leaf.id) {
			replacement.focus({ preventScroll: true });
		}
	}
</script>

<div class="panel-top-actions-row collection-view-picker">
	{#if groups.length}
		<div class="secondary-tabs" role="group" aria-label="Token kind">
			{#each groups as group (group.id)}
				{#if group.id === kind}
					<span class="secondary-tab-active" aria-current="true">{group.label}</span>
				{:else}
					<a href={group.href}>{group.label}</a>
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
					<option value="" disabled>Choose block</option>
					{#each leaves as leaf (leaf.id)}
						<option value={leaf.id}>{leaf.label}</option>
					{/each}
				</select>
			</label>
		{/if}
	{:else}
		<span class="muted">Waiting for indexed token traits.</span>
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
