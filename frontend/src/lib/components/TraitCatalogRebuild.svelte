<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
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
			if (active) error = 'Could not start the rebuild. Try again.';
		} finally {
			if (active) submitting = false;
		}
	}

	async function refresh(): Promise<void> {
		if (!run) return;
		try {
			const result = await getTraitCatalogRebuild(fetch, chainRef, collectionRef, run.runId);
			if (!active) return;
			run = result.rebuild;
			if (run.status === Status.Completed) await invalidateAll();
			error = '';
		} catch {
			if (active) error = 'Could not load rebuild progress. Retry.';
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
		<h2 class="customization-title">Derived traits · {view.label}</h2>
	</header>
	<div class="customization-section">
		<div>Active mapping <span class="mono">{view.activeMapperVersion}</span></div>
		<div>Available mapping <span class="mono">{view.availableMapperVersion}</span></div>
		<button
			type="button"
			class="bootstrap-control"
			disabled={submitting || run?.status === Status.Running}
			onclick={start}
		>
			{retryRunId ? 'Retry rebuild' : 'Rebuild traits'}
		</button>
		{#if run}
			<span role="status">{run.status} · {run.processed} of {run.total} NFTs</span>
		{/if}
		{#if error}
			<p role="alert">
				{error}
				{#if run?.status === Status.Running}
					<button type="button" class="bootstrap-control" onclick={refresh}>Retry</button>
				{/if}
			</p>
		{/if}
	</div>
</section>
