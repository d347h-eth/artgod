<script lang="ts">
	import { browser } from '$app/environment';
	import { getBootstrapRunDetail, retryBootstrapFailedTasks } from '$lib/backend-api';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import type { BootstrapRunDetailApiResponse } from '$lib/api-types';
	import { APP_VERSION } from '$lib/runtime/app-version';

	const BOOTSTRAP_POLL_INTERVAL_MS = 1_000;

	let {
		chainRef,
		runId,
		initialDetail
	}: {
		chainRef: string;
		runId: number | null;
		initialDetail: BootstrapRunDetailApiResponse | null;
	} = $props();

	let detail = $state<BootstrapRunDetailApiResponse | null>(initialDetail);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let retryPending = $state(false);
	let retryMessage = $state<string | null>(null);
	let refreshInFlight = false;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		detail = initialDetail;
	});

	$effect(() => {
		if (!browser || !chainRef || !runId) return;
		stopRefreshTimer();
		void refreshRunDetail();
		refreshTimer = setInterval(() => {
			void refreshRunDetail();
		}, BOOTSTRAP_POLL_INTERVAL_MS);
		return () => stopRefreshTimer();
	});

	function collectionHref(): string {
		if (!chainRef || !detail) return '#';
		return `/${chainRef}/${detail.collection.slug ?? detail.collection.address}`;
	}

	async function refreshRunDetail(): Promise<void> {
		if (!chainRef || !runId || refreshInFlight) return;
		refreshInFlight = true;
		loading = true;
		loadError = null;
		try {
			detail = await getBootstrapRunDetail(fetch, chainRef, runId);
			if (detail?.flow.shouldPoll === false) {
				stopRefreshTimer();
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'bootstrap run request failed';
		} finally {
			loading = false;
			refreshInFlight = false;
		}
	}

	function stopRefreshTimer(): void {
		if (refreshTimer === null) return;
		clearInterval(refreshTimer);
		refreshTimer = null;
	}

	async function onRetryFailedTasks(): Promise<void> {
		if (!chainRef || !runId || retryPending) return;
		retryPending = true;
		retryMessage = null;
		try {
			const result = await retryBootstrapFailedTasks(fetch, chainRef, runId);
			retryMessage = `retry queued for ${result.updatedCount} task(s)`;
			await refreshRunDetail();
		} catch (error) {
			retryMessage = error instanceof Error ? error.message : 'retry request failed';
		} finally {
			retryPending = false;
		}
	}

	function flowProgressLabel(
		step: NonNullable<BootstrapRunDetailApiResponse['flow']>['steps'][number]
	): string | null {
		if (!step.progress) return null;
		return `${step.progress.completed} / ${step.progress.total}`;
	}
</script>

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={chainRef || null} active={null} />

	<header class="panel-header">
		<div>
			<p class="panel-subtitle">
				{#if chainRef && runId}
					{chainRef} / bootstrap run #{runId}
				{:else}
					bootstrap run detail
				{/if}
			</p>
		</div>
	</header>

	{#if detail}
		<section class="panel-header bootstrap-panel bootstrap-detail-summary">
			<div class="bootstrap-summary-grid bootstrap-detail-summary-grid">
				<div>
					<div class="muted">collection</div>
					<div>
						<a href={collectionHref()}>{detail.collection.slug ?? detail.collection.address}</a>
					</div>
				</div>
				<div>
					<div class="muted">status</div>
					<div>{detail.run.status}</div>
				</div>
				<div>
					<div class="muted">updated</div>
					<div class="mono">{detail.run.updatedAt}</div>
				</div>
				<div>
					<div class="muted">metadata mode</div>
					<div>{detail.run.metadataMode}</div>
				</div>
				<div>
					<div class="muted">enumeration</div>
					<div>{detail.run.enumerationMode}</div>
				</div>
				<div>
					<div class="muted">anchor block</div>
					<div class="mono">{detail.run.anchorBlock ?? '-'}</div>
				</div>
			</div>
			<div class="bootstrap-actions">
				<button type="button" onclick={() => void refreshRunDetail()} disabled={loading}>
					{loading ? 'refreshing...' : 'refresh'}
				</button>
				{#if detail.isLatestForCollection}
					<button
						type="button"
						onclick={() => void onRetryFailedTasks()}
						disabled={retryPending || detail.metadataTasks.failedTerminal <= 0}
					>
						{retryPending ? 'retrying...' : 'retry failed'}
					</button>
				{:else}
					<span class="muted">retry disabled for non-latest runs</span>
				{/if}
			</div>
			{#if retryMessage}
				<div class="muted">{retryMessage}</div>
			{/if}
			{#if detail.run.errorMessage}
				<div class="muted">{detail.run.errorMessage}</div>
			{/if}
			{#if loadError}
				<div class="muted">{loadError}</div>
			{/if}
		</section>

		<section class="bootstrap-flow-panel">
			<div class="bootstrap-flow-strip" role="list" aria-label="bootstrap flow">
				{#each detail.flow.steps as step}
					<div class={`bootstrap-flow-step bootstrap-flow-step-${step.state}`} role="listitem">
						<div class="bootstrap-flow-step-label">{step.label}</div>
						{#if flowProgressLabel(step)}
							<div class="mono bootstrap-flow-step-progress">{flowProgressLabel(step)}</div>
						{/if}
						{#if step.detailText}
							<div class="mono bootstrap-flow-step-detail">{step.detailText}</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		{#if detail.failedMetadataTasksPreview.length > 0}
			<section class="bootstrap-failed-tasks">
				<div class="panel-header">
					<h2 class="panel-title">Failed Metadata Tasks</h2>
					<span class="muted"
						>first {detail.failedMetadataTasksPreviewLimit} failed_terminal tasks in this run</span
					>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>token id</th>
								<th>status</th>
								<th>attempts</th>
								<th>next attempt</th>
								<th>last error</th>
							</tr>
						</thead>
						<tbody>
							{#each detail.failedMetadataTasksPreview as task}
								<tr>
									<td class="mono">{task.tokenId}</td>
									<td>{task.status}</td>
									<td class="mono">{task.attempts}</td>
									<td class="mono">{task.nextAttemptAt}</td>
									<td class="mono">{task.lastError ?? '-'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{:else}
		<section class="panel-header">
			<div class="muted">run not found</div>
			{#if loadError}
				<div class="muted">{loadError}</div>
			{/if}
		</section>
	{/if}
</section>
