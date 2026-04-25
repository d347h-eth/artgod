<script lang="ts">
	import type { ApiBiddingJob, ApiBiddingJobStatus, ApiTradingTraitCriterion } from '$lib/api-types';
	import { archiveTokenBiddingJob, upsertTokenBiddingJob } from '$lib/backend-api';
	import { buildTokenDetailHref } from '$lib/token-browser-query';

	type EditableTokenStatus = Exclude<ApiBiddingJobStatus, 'archived'>;

	let {
		chainRef,
		collectionRef,
		collectionBasePath,
		returnPath,
		returnQuery,
		mediaMode,
		job,
		onJobUpdated,
		onJobArchived
	}: {
		chainRef: string;
		collectionRef: string;
		collectionBasePath: string;
		returnPath: string;
		returnQuery: string;
		mediaMode: string | null;
		job: ApiBiddingJob;
		onJobUpdated: (job: ApiBiddingJob) => void;
		onJobArchived: (jobId: string) => void;
	} = $props();

	let status = $state<EditableTokenStatus>(editableStatus(job.status));
	let floorEth = $state(job.config.floorEth);
	let ceilingEth = $state(job.config.ceilingEth);
	let deltaEth = $state(job.config.deltaEth);
	let saving = $state(false);
	let archiving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);

	const tokenJob = $derived(job.target.type === 'token');
	const hasDraftChanges = $derived(
		job.target.type === 'token' &&
			(status !== editableStatus(job.status) ||
				floorEth.trim() !== job.config.floorEth ||
				ceilingEth.trim() !== job.config.ceilingEth ||
				deltaEth.trim() !== job.config.deltaEth)
	);

	$effect(() => {
		status = editableStatus(job.status);
		floorEth = job.config.floorEth;
		ceilingEth = job.config.ceilingEth;
		deltaEth = job.config.deltaEth;
		saving = false;
		archiving = false;
		saveMessage = null;
		saveError = null;
	});

	function editableStatus(value: ApiBiddingJobStatus): EditableTokenStatus {
		return value === 'paused' ? 'paused' : 'enabled';
	}

	function formatEthLabel(value: string | null): string {
		if (value === null || value.trim().length === 0) {
			return '—';
		}
		return `${value} ETH`;
	}

	function formatTargetCriteria(criteria: ApiTradingTraitCriterion[]): string {
		if (criteria.length === 0) {
			return 'all tokens';
		}
		return criteria.map((criterion) => `${criterion.type}:${criterion.value}`).join(', ');
	}

	function targetSummary(): string {
		if (job.target.type === 'token') {
			return `token ${job.target.tokenId}`;
		}
		if (job.target.type === 'collection') {
			return `quantity ${job.target.quantity} · ${formatTargetCriteria(job.target.targetTraits)}`;
		}
		return `quantity ${job.target.quantity} · target ${formatTargetCriteria(job.target.targetTraits)} · competitors ${formatTargetCriteria(job.target.competitorTraits)}`;
	}

	function targetLabel(): string {
		if (job.target.type === 'token') {
			return 'token';
		}
		if (job.target.type === 'collection') {
			return 'collection scope';
		}
		return 'competitive trait';
	}

	function tokenHref(): string | null {
		if (job.target.type !== 'token') {
			return null;
		}
		return buildTokenDetailHref({
			basePath: collectionBasePath,
			tokenId: job.target.tokenId,
			mediaMode,
			returnPath,
			returnQuery
		});
	}

	function activeOrderLabel(): string {
		if (!job.runtime?.activeOrderId) {
			return '—';
		}
		return job.runtime.activeOrderId;
	}

	function resetDraft(): void {
		status = editableStatus(job.status);
		floorEth = job.config.floorEth;
		ceilingEth = job.config.ceilingEth;
		deltaEth = job.config.deltaEth;
		saveMessage = null;
		saveError = null;
	}

	async function handleSave(): Promise<void> {
		if (job.target.type !== 'token' || saving || archiving || !hasDraftChanges) {
			return;
		}

		saving = true;
		saveMessage = null;
		saveError = null;

		try {
			// Persist the updated token job through the backend CRUD adapter.
			const response = await upsertTokenBiddingJob(fetch, chainRef, collectionRef, job.target.tokenId, {
				status,
				floorEth: floorEth.trim(),
				ceilingEth: ceilingEth.trim(),
				deltaEth: deltaEth.trim()
			});
			onJobUpdated(response.job);
			saveMessage = 'saved';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to update bidding job';
		} finally {
			saving = false;
		}
	}

	async function handleArchive(): Promise<void> {
		if (job.target.type !== 'token' || saving || archiving) {
			return;
		}

		if (typeof window !== 'undefined') {
			const confirmed = window.confirm(
				`Archive bidding job for token ${job.target.tokenId}? Active offer cleanup will be queued.`
			);
			if (!confirmed) {
				return;
			}
		}

		archiving = true;
		saveMessage = null;
		saveError = null;

		try {
			// Archive the token job through the backend CRUD adapter.
			await archiveTokenBiddingJob(fetch, chainRef, collectionRef, job.target.tokenId);
			onJobArchived(job.jobId);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to archive bidding job';
		} finally {
			archiving = false;
		}
	}
</script>

<tr>
	<td class="bidding-target-cell">
		<div class="bidding-target-label mono">{targetLabel()}</div>
		{#if job.target.type === 'token'}
			<a class="token-table-id-link mono" href={tokenHref() ?? '#'}>token {job.target.tokenId}</a>
		{:else}
			<div class="bidding-target-summary">{targetSummary()}</div>
		{/if}
		<div class="muted">
			rev {job.revision} · updated <span class="mono">{job.updatedAt}</span>
		</div>
	</td>
	<td class="bidding-status-cell">
		{#if tokenJob}
			<select
				class="bootstrap-control bidding-status-select"
				bind:value={status}
				disabled={saving || archiving}
			>
				<option value="enabled">enabled</option>
				<option value="paused">paused</option>
			</select>
		{:else}
			<span class="mono">{job.status}</span>
		{/if}
	</td>
	<td class="bidding-config-cell">
		{#if tokenJob}
			<input
				class="bootstrap-control bidding-number-input"
				type="text"
				inputmode="decimal"
				bind:value={floorEth}
				disabled={saving || archiving}
			/>
		{:else}
			<span class="mono">{job.config.floorEth}</span>
		{/if}
	</td>
	<td class="bidding-config-cell">
		{#if tokenJob}
			<input
				class="bootstrap-control bidding-number-input"
				type="text"
				inputmode="decimal"
				bind:value={ceilingEth}
				disabled={saving || archiving}
			/>
		{:else}
			<span class="mono">{job.config.ceilingEth}</span>
		{/if}
	</td>
	<td class="bidding-config-cell">
		{#if tokenJob}
			<input
				class="bootstrap-control bidding-number-input"
				type="text"
				inputmode="decimal"
				bind:value={deltaEth}
				disabled={saving || archiving}
			/>
		{:else}
			<span class="mono">{job.config.deltaEth}</span>
		{/if}
	</td>
	<td class="bidding-runtime-cell">
		<div class="bidding-runtime-lines">
			<div>
				<span class="runtime-k">current</span>
				<span class="runtime-v">{formatEthLabel(job.runtime?.currentPriceEth ?? null)}</span>
			</div>
			<div>
				<span class="runtime-k">active order</span>
				<span class="runtime-v mono">{activeOrderLabel()}</span>
			</div>
			<div>
				<span class="runtime-k">last run</span>
				<span class="runtime-v mono">{job.runtime?.lastRunAt ?? '—'}</span>
			</div>
			{#if job.runtime?.lastError}
				<p class="runtime-error bidding-row-error" role="alert">{job.runtime.lastError}</p>
			{/if}
		</div>
	</td>
	<td class="bidding-actions-cell">
		{#if tokenJob}
			<div class="bidding-row-actions">
				<button type="button" onclick={() => void handleSave()} disabled={saving || archiving || !hasDraftChanges}>
					{saving ? 'saving…' : 'save'}
				</button>
				<button type="button" onclick={resetDraft} disabled={saving || archiving || !hasDraftChanges}>
					reset
				</button>
				<button type="button" onclick={() => void handleArchive()} disabled={saving || archiving}>
					{archiving ? 'archiving…' : 'archive'}
				</button>
			</div>
		{:else}
			<p class="muted bidding-row-note">inline token controls only</p>
		{/if}
		{#if saveMessage}
			<p class="runtime-pass bidding-row-note">{saveMessage}</p>
		{/if}
		{#if saveError}
			<p class="runtime-error bidding-row-note" role="alert">{saveError}</p>
		{/if}
	</td>
</tr>
