<script lang="ts">
	import { onMount } from 'svelte';
	import {
		applyBootstrapStepAction,
		getBootstrapRunDetail
	} from '$lib/backend-api';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import type { ApiBootstrapFlowStep, BootstrapRunDetailApiResponse } from '$lib/api-types';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import {
		BOOTSTRAP_STEP_ACTION,
		isBootstrapStepKey,
		type BootstrapStepAction
	} from '@artgod/shared/bootstrap/pipeline';
	import {
		LIVE_REFRESH_RELATIVE_TIME_TICK_MS,
		formatLiveRefreshNextUpdate,
		liveRefreshNextUpdateTitle,
		startScheduledLiveRefresh,
		type ScheduledLiveRefreshHandle
	} from '$lib/live-refresh';

	// Bootstrap run details refresh at the same steady live cadence as compact status surfaces.
	const BOOTSTRAP_RUN_DETAIL_LIVE_REFRESH_INTERVAL_MS = 5_000;

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
	let loadError = $state<string | null>(null);
	let stepActionPending = $state<string | null>(null);
	let stepActionError = $state<string | null>(null);
	let nextRefreshAtMs = $state<number | null>(null);
	let refreshClockNowMs = $state(Date.now());
	let refreshInFlight = false;
	let liveRefreshHandle: ScheduledLiveRefreshHandle | null = null;

	$effect(() => {
		detail = initialDetail;
	});

	onMount(() => {
		startDetailLiveRefresh();
		const clockTimer = window.setInterval(() => {
			refreshClockNowMs = Date.now();
		}, LIVE_REFRESH_RELATIVE_TIME_TICK_MS);
		return () => {
			stopDetailLiveRefresh();
			window.clearInterval(clockTimer);
		};
	});

	function collectionHref(): string {
		if (!chainRef || !detail) return '#';
		return `/${chainRef}/${detail.collection.slug}`;
	}

	async function refreshRunDetail(): Promise<void> {
		if (!chainRef || !runId || refreshInFlight) return;
		refreshInFlight = true;
		loadError = null;
		try {
			detail = await getBootstrapRunDetail(fetch, chainRef, runId);
			if (detail?.flow.shouldPoll === false) {
				stopDetailLiveRefresh();
			} else {
				startDetailLiveRefresh();
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'bootstrap run request failed';
		} finally {
			refreshInFlight = false;
		}
	}

	function startDetailLiveRefresh(): void {
		if (liveRefreshHandle || !chainRef || !runId || detail?.flow.shouldPoll === false) return;
		liveRefreshHandle = startScheduledLiveRefresh({
			refresh: () => refreshRunDetail(),
			intervalMs: () => BOOTSTRAP_RUN_DETAIL_LIVE_REFRESH_INTERVAL_MS,
			onNextUpdate: (nextUpdateAtMs) => {
				nextRefreshAtMs = nextUpdateAtMs;
				refreshClockNowMs = Date.now();
			}
		});
	}

	function stopDetailLiveRefresh(): void {
		if (!liveRefreshHandle) return;
		liveRefreshHandle.stop();
		liveRefreshHandle = null;
	}

	async function onStepAction(
		step: ApiBootstrapFlowStep,
		action: BootstrapStepAction
	): Promise<void> {
		if (!chainRef || !runId) return;
		if (!isBootstrapStepKey(step.key)) return;
		const pendingKey = stepActionKey(step, action);
		if (stepActionPending) return;
		stepActionPending = pendingKey;
		stepActionError = null;
		try {
			await applyBootstrapStepAction(fetch, chainRef, runId, step.key, action);
			await refreshRunDetail();
		} catch (error) {
			stepActionError = error instanceof Error ? error.message : 'bootstrap step action failed';
		} finally {
			stepActionPending = null;
		}
	}

	function stepActionKey(step: ApiBootstrapFlowStep, action: BootstrapStepAction): string {
		return `${step.key}:${action}`;
	}

	function stepActionLabel(action: BootstrapStepAction): string {
		if (action === BOOTSTRAP_STEP_ACTION.Pause) return 'pause';
		if (action === BOOTSTRAP_STEP_ACTION.Resume) return 'resume';
		return 'retry';
	}

	function flowProgressLabel(step: ApiBootstrapFlowStep): string | null {
		if (!step.progress) return null;
		return `${step.progress.completed} / ${step.progress.total}`;
	}

	function flowProgressPercentLabel(step: ApiBootstrapFlowStep): string | null {
		if (!step.progress || step.progress.total <= 0) return null;
		const percent = Math.round((step.progress.completed / step.progress.total) * 100);
		return `${Math.min(100, Math.max(0, percent))}%`;
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
						<a href={collectionHref()}>{detail.collection.slug}</a>
					</div>
				</div>
				<div>
					<div class="muted">status</div>
					<div>{detail.run.status}</div>
				</div>
				<div class="bootstrap-detail-refresh-meta">
					<span class="runtime-k">next refresh</span>
					<span
						class="runtime-v mono bid-book-update-chip"
						title={liveRefreshNextUpdateTitle(nextRefreshAtMs)}
					>
						{formatLiveRefreshNextUpdate(nextRefreshAtMs, refreshClockNowMs)}
					</span>
				</div>
			</div>
			{#if detail.run.errorMessage}
				<div class="muted">{detail.run.errorMessage}</div>
			{/if}
			{#if loadError}
				<div class="muted">{loadError}</div>
			{/if}
			{#if stepActionError}
				<div class="muted">{stepActionError}</div>
			{/if}
		</section>

		<section class="bootstrap-flow-panel">
			<div class="bootstrap-flow-strip" role="list" aria-label="bootstrap flow">
				{#each detail.flow.steps as step}
					<div class={`bootstrap-flow-step bootstrap-flow-step-${step.state}`} role="listitem">
						<div class="bootstrap-flow-step-label">{step.label}</div>
						{#if flowProgressLabel(step)}
							<div class="mono bootstrap-flow-step-progress">{flowProgressLabel(step)}</div>
							{#if flowProgressPercentLabel(step)}
								<div class="mono bootstrap-flow-step-progress-percent">
									{flowProgressPercentLabel(step)}
								</div>
							{/if}
						{/if}
						{#if step.detailText}
							<div class="mono bootstrap-flow-step-detail">{step.detailText}</div>
						{/if}
						{#if step.availableActions.length > 0}
							<div class="bootstrap-flow-step-actions">
								{#each step.availableActions as action}
									<button
										type="button"
										class="bootstrap-flow-step-action"
										onclick={() => void onStepAction(step, action)}
										disabled={stepActionPending !== null}
										aria-label={`${stepActionLabel(action)} ${step.label}`}
									>
										{#if stepActionPending === stepActionKey(step, action)}
											{stepActionLabel(action)}...
										{:else}
											{stepActionLabel(action)}
										{/if}
									</button>
								{/each}
							</div>
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
