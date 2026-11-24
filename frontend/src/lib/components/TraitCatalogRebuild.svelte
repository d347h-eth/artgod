<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
	import { appendCatalogScope } from '$lib/collection-view';
	import {
		TRAIT_CATALOG_REBUILD_STATUS as Status,
		type CollectionViewStatus
	} from '@artgod/shared/types/trait-catalog';
	import { getTraitCatalogRebuild, startTraitCatalogRebuild } from '$lib/backend-api';

	const POLL_INTERVAL_MS = 1500;

	let {
		chainRef,
		collectionRef,
		view
	}: {
		chainRef: string;
		collectionRef: string;
		view: CollectionViewStatus;
	} = $props();

	let run = $state(untrack(() => view.latestRun ?? null));
	let submitting = $state(false);
	let error = $state('');
	let active = true;
	let retryRunId = $derived(
		run?.status === Status.Failed && run.mapperVersion === view.availableMapperVersion
			? run.runId
			: undefined
	);

	onDestroy(() => {
		active = false;
	});

	async function start(): Promise<void> {
		if (submitting || run?.status === Status.Running) return;
		submitting = true;
		error = '';
		try {
			const response = await startTraitCatalogRebuild(
				fetch,
				chainRef,
				collectionRef,
				view.id,
				view.availableMapperVersion,
				retryRunId
			);
			if (active) run = response.rebuild;
		} catch {
			if (active) error = 'Could not start the rebuild.';
		} finally {
			if (active) submitting = false;
		}
	}

	async function refresh(): Promise<void> {
		if (!run) return;
		try {
			const result = await getTraitCatalogRebuild(fetch, chainRef, collectionRef, run.runId);
			if (!active) return;
			if (result.rebuild.status === Status.Completed) {
				const destination = new URL(page.url.href);
				destination.searchParams.delete(PAGINATION_QUERY_PARAMS.Cursor);
				appendCatalogScope(destination.searchParams, {
					id: view.id,
					generation: result.rebuild.generation
				});
				await goto(destination, { replace: true, reset: false, refreshAll: true });
			}
			if (active) {
				run = result.rebuild;
				error = '';
			}
		} catch {
			if (active) error = 'Could not load rebuild progress.';
		}
	}

	$effect(() => {
		if (run?.status !== Status.Running || error) return;
		const timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
		return () => clearTimeout(timer);
	});
</script>

<section class="customization-feature-panel">
	<header class="panel-header">
		<h2 class="customization-title">Derived traits</h2>
	</header>
	<div class="customization-section">
		<span class="muted">Active mapping <span class="mono">{view.activeMapperVersion}</span></span>
		{#if view.availableMapperVersion !== view.activeMapperVersion}
			<span class="muted">Available mapping <span class="mono">{view.availableMapperVersion}</span></span>
		{/if}
	</div>
	<footer class="panel-footer customization-footer">
		<button
			type="button"
			class="button-link"
			disabled={submitting || run?.status === Status.Running}
			onclick={start}
		>
			{retryRunId || (error && run?.status !== Status.Running) ? 'Retry rebuild' : 'Rebuild traits'}
		</button>
		{#if run}
			<span class="muted" role="status">{run.status} · {run.processed} of {run.total} NFTs</span>
		{/if}
		{#if error}
			<p class="muted" role="alert">
				{error}
				{#if run?.status === Status.Running}
					<button type="button" class="button-link" onclick={refresh}>Retry</button>
				{/if}
			</p>
		{/if}
	</footer>
</section>
