<script lang="ts">
	import type { ApiBiddingJob, ApiChain, ApiCollection, ApiTokenDetail } from '$lib/api-types';
	import { archiveTokenBiddingJob, upsertTokenBiddingJob } from '$lib/backend-api';

	type EditableTokenJobStatus = 'enabled' | 'paused';

	let {
		chain,
		collection,
		token,
		job,
		collectionBiddingHref
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenDetail | null;
		job: ApiBiddingJob | null;
		collectionBiddingHref: string;
	} = $props();

	let currentJob = $state<ApiBiddingJob | null>(job);
	let status = $state<EditableTokenJobStatus>('enabled');
	let floorEth = $state('');
	let ceilingEth = $state('');
	let deltaEth = $state('');
	let saving = $state(false);
	let archiving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);

	const hasExistingJob = $derived(currentJob !== null);
	const hasRuntimeState = $derived(currentJob?.runtime !== null && currentJob?.runtime !== undefined);
	const hasDraftChanges = $derived(resolveHasDraftChanges());

	$effect(() => {
		currentJob = job;
		resetDraft();
		saving = false;
		archiving = false;
		saveMessage = null;
		saveError = null;
	});

	function resolveInitialStatus(): EditableTokenJobStatus {
		return currentJob?.status === 'paused' ? 'paused' : 'enabled';
	}

	function resolveHasDraftChanges(): boolean {
		if (currentJob) {
			return (
				status !== resolveInitialStatus() ||
				floorEth.trim() !== currentJob.config.floorEth ||
				ceilingEth.trim() !== currentJob.config.ceilingEth ||
				deltaEth.trim() !== currentJob.config.deltaEth
			);
		}

		return (
			status !== 'enabled' ||
			floorEth.trim().length > 0 ||
			ceilingEth.trim().length > 0 ||
			deltaEth.trim().length > 0
		);
	}

	function resetDraft(): void {
		status = resolveInitialStatus();
		floorEth = currentJob?.config.floorEth ?? '';
		ceilingEth = currentJob?.config.ceilingEth ?? '';
		deltaEth = currentJob?.config.deltaEth ?? '';
		saveMessage = null;
		saveError = null;
	}

	function formatEthLabel(value: string | null): string {
		if (value === null || value.trim().length === 0) {
			return '—';
		}
		return `${value} ETH`;
	}

	async function handleSave(): Promise<void> {
		if (!chain || !collection || !token || saving || archiving) {
			return;
		}

		const wasExistingJob = currentJob !== null;
		saving = true;
		saveMessage = null;
		saveError = null;

		try {
			// Persist the token-scoped bidding job through the backend CRUD adapter.
			const response = await upsertTokenBiddingJob(fetch, chain.slug, collection.slug, token.tokenId, {
				status,
				floorEth: floorEth.trim(),
				ceilingEth: ceilingEth.trim(),
				deltaEth: deltaEth.trim()
			});
			currentJob = response.job;
			resetDraft();
			saveMessage = wasExistingJob ? 'saved' : 'created';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to save token bidding job';
		} finally {
			saving = false;
		}
	}

	async function handleArchive(): Promise<void> {
		if (!chain || !collection || !token || !currentJob || saving || archiving) {
			return;
		}

		if (typeof window !== 'undefined') {
			const confirmed = window.confirm(
				`Archive bidding job for token ${token.tokenId}? Active offer cleanup will be queued.`
			);
			if (!confirmed) {
				return;
			}
		}

		archiving = true;
		saveMessage = null;
		saveError = null;

		try {
			// Archive the token-scoped bidding job through the backend CRUD adapter.
			await archiveTokenBiddingJob(fetch, chain.slug, collection.slug, token.tokenId);
			currentJob = null;
			resetDraft();
			saveMessage = 'archived';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to archive token bidding job';
		} finally {
			archiving = false;
		}
	}
</script>

<section class="runtime-section token-bidding-panel">
	<header class="panel-header token-bidding-panel-header">
		<div>
			<h2 class="panel-title">token bidding</h2>
			<p class="muted">manage the token-scoped bidder job for this token</p>
		</div>
		<a class="button-link" href={collectionBiddingHref}>collection bidding page</a>
	</header>

	{#if currentJob}
		<div class="runtime-kv-grid token-bidding-runtime-grid">
			<div>
				<span class="runtime-k">job</span>
				<span class="runtime-v mono">{currentJob.jobId}</span>
			</div>
			<div>
				<span class="runtime-k">revision</span>
				<span class="runtime-v">{currentJob.revision}</span>
			</div>
			<div>
				<span class="runtime-k">updated</span>
				<span class="runtime-v mono">{currentJob.updatedAt}</span>
			</div>
			{#if hasRuntimeState}
				<div>
					<span class="runtime-k">current price</span>
					<span class="runtime-v">{formatEthLabel(currentJob.runtime?.currentPriceEth ?? null)}</span>
				</div>
				<div>
					<span class="runtime-k">active order</span>
					<span class="runtime-v mono">{currentJob.runtime?.activeOrderId ?? '—'}</span>
				</div>
				<div>
					<span class="runtime-k">last run</span>
					<span class="runtime-v mono">{currentJob.runtime?.lastRunAt ?? '—'}</span>
				</div>
			{/if}
		</div>
		{#if currentJob.runtime?.lastError}
			<p class="runtime-error token-bidding-feedback" role="alert">{currentJob.runtime.lastError}</p>
		{/if}
	{:else}
		<p class="muted token-bidding-feedback">
			no token-scoped bidding job exists yet. collection and trait-scoped jobs are managed from the
			collection bidding page.
		</p>
	{/if}

	<form
		class="bootstrap-form token-bidding-form"
		onsubmit={(event) => {
			event.preventDefault();
			void handleSave();
		}}
	>
		<div class="bootstrap-form-row">
			<label for="token-bidding-status"><span>status</span></label>
			<select
				id="token-bidding-status"
				class="bootstrap-control bootstrap-input-select-short"
				bind:value={status}
				disabled={saving || archiving}
			>
				<option value="enabled">enabled</option>
				<option value="paused">paused</option>
			</select>
		</div>
		<div class="bootstrap-form-row">
			<label for="token-bidding-floor"><span>floor ETH</span></label>
			<input
				id="token-bidding-floor"
				class="bootstrap-control bidding-token-input"
				type="text"
				inputmode="decimal"
				bind:value={floorEth}
				disabled={saving || archiving}
			/>
		</div>
		<div class="bootstrap-form-row">
			<label for="token-bidding-ceiling"><span>ceiling ETH</span></label>
			<input
				id="token-bidding-ceiling"
				class="bootstrap-control bidding-token-input"
				type="text"
				inputmode="decimal"
				bind:value={ceilingEth}
				disabled={saving || archiving}
			/>
		</div>
		<div class="bootstrap-form-row">
			<label for="token-bidding-delta"><span>delta ETH</span></label>
			<input
				id="token-bidding-delta"
				class="bootstrap-control bidding-token-input"
				type="text"
				inputmode="decimal"
				bind:value={deltaEth}
				disabled={saving || archiving}
			/>
		</div>
		<div class="panel-footer token-bidding-form-footer">
			<div class="token-bidding-form-actions">
				<button type="submit" disabled={saving || archiving || !hasDraftChanges}>
					{#if saving}
						saving…
					{:else if hasExistingJob}
						save
					{:else}
						create
					{/if}
				</button>
				<button type="button" onclick={resetDraft} disabled={saving || archiving || !hasDraftChanges}>
					reset
				</button>
				{#if hasExistingJob}
					<button type="button" onclick={() => void handleArchive()} disabled={saving || archiving}>
						{archiving ? 'archiving…' : 'archive'}
					</button>
				{/if}
			</div>
			<div class="bootstrap-form-feedback">
				{#if saveMessage}
					<p class="runtime-pass token-bidding-feedback">{saveMessage}</p>
				{/if}
				{#if saveError}
					<p class="runtime-error token-bidding-feedback" role="alert">{saveError}</p>
				{/if}
			</div>
		</div>
	</form>
</section>
