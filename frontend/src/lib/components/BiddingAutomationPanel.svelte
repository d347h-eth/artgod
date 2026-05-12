<script lang="ts">
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiTokenDetail
	} from '$lib/api-types';
	import { archiveTokenBiddingJob, upsertTokenBiddingJob } from '$lib/backend-api';

	type EditableTokenJobStatus = 'enabled' | 'paused';

	let {
		open,
		chain,
		collection,
		token,
		job,
		bidBook = null,
		onClose,
		onJobChange = null
	}: {
		open: boolean;
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenDetail | null;
		job: ApiBiddingJob | null;
		bidBook?: ApiBiddingBidBook | null;
		onClose: () => void;
		onJobChange?: ((job: ApiBiddingJob | null) => void) | null;
	} = $props();

	let currentJob = $state<ApiBiddingJob | null>(job);
	let loadedJobKey = $state(resolveLoadedJobKey(job));
	let status = $state<EditableTokenJobStatus>(resolveInitialStatus(job));
	let floorEth = $state(job?.config.floorEth ?? '');
	let ceilingEth = $state(job?.config.ceilingEth ?? '');
	let deltaEth = $state(job?.config.deltaEth ?? '');
	let saving = $state(false);
	let archiving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);

	const hasExistingJob = $derived(currentJob !== null);
	const hasRuntimeState = $derived(currentJob?.runtime !== null && currentJob?.runtime !== undefined);
	const hasDraftChanges = $derived(resolveHasDraftChanges());
	const bidPosition = $derived(resolveBidPosition(currentJob, bidBook));

	$effect(() => {
		const nextLoadedJobKey = resolveLoadedJobKey(job);
		if (nextLoadedJobKey === loadedJobKey) {
			return;
		}

		loadedJobKey = nextLoadedJobKey;
		applyLoadedJob(job);
		saving = false;
		archiving = false;
		saveMessage = null;
		saveError = null;
	});

	function resolveLoadedJobKey(value: ApiBiddingJob | null): string {
		if (!value) {
			return 'empty';
		}
		return [
			value.jobId,
			value.revision,
			value.status,
			value.config.floorEth,
			value.config.ceilingEth,
			value.config.deltaEth
		].join(':');
	}

	function resolveInitialStatus(value: ApiBiddingJob | null): EditableTokenJobStatus {
		return value?.status === 'paused' ? 'paused' : 'enabled';
	}

	function resolveHasDraftChanges(): boolean {
		if (currentJob) {
			return (
				status !== resolveInitialStatus(currentJob) ||
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
		applyDraft(currentJob);
		saveMessage = null;
		saveError = null;
	}

	function applyLoadedJob(value: ApiBiddingJob | null): void {
		currentJob = value;
		applyDraft(value);
	}

	function applyDraft(value: ApiBiddingJob | null): void {
		status = resolveInitialStatus(value);
		floorEth = value?.config.floorEth ?? '';
		ceilingEth = value?.config.ceilingEth ?? '';
		deltaEth = value?.config.deltaEth ?? '';
	}

	function formatEthLabel(value: string | null): string {
		if (value === null || value.trim().length === 0) {
			return '-';
		}
		return `${value} ETH`;
	}

	function resolveBidPosition(
		currentValue: ApiBiddingJob | null,
		currentBidBook: ApiBiddingBidBook | null
	): string | null {
		if (!currentValue || !currentBidBook) {
			return null;
		}

		const ownBid = bestBid(currentBidBook.bids, (bid) => bid.maker.isOwn);
		if (!ownBid) {
			return 'no active bid';
		}

		const opponentBid = bestBid(currentBidBook.bids, (bid) => !bid.maker.isOwn);
		if (!opponentBid || BigInt(ownBid.priceWei) >= BigInt(opponentBid.priceWei)) {
			return 'winning';
		}
		return 'outbid';
	}

	function bestBid(
		bids: ApiBiddingBidBookRow[],
		predicate: (bid: ApiBiddingBidBookRow) => boolean
	): ApiBiddingBidBookRow | null {
		return bids.filter(predicate).sort((left, right) => {
			const leftPrice = BigInt(left.priceWei);
			const rightPrice = BigInt(right.priceWei);
			if (leftPrice === rightPrice) {
				return left.orderId.localeCompare(right.orderId);
			}
			return leftPrice > rightPrice ? -1 : 1;
		})[0] ?? null;
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
			onJobChange?.(response.job);
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
			onJobChange?.(null);
			resetDraft();
			saveMessage = 'archived';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to archive token bidding job';
		} finally {
			archiving = false;
		}
	}
</script>

{#if open}
	<div class="runtime-section bidding-automation-panel" role="dialog" aria-label="bidding automation">
		<header class="panel-header bidding-automation-panel-header">
			<h2 class="panel-title">token bidding</h2>
			<button type="button" class="button-link" onclick={onClose}>close</button>
		</header>

		<div class="runtime-kv-grid token-bidding-runtime-grid">
			<div>
				<span class="runtime-k">target</span>
				<span class="runtime-v mono">#{token?.tokenId ?? '-'}</span>
			</div>
			{#if currentJob}
				<div>
					<span class="runtime-k">updated</span>
					<span class="runtime-v mono">{currentJob.updatedAt}</span>
				</div>
			{/if}
			{#if bidPosition}
				<div>
					<span class="runtime-k">position</span>
					<span class="runtime-v">{bidPosition}</span>
				</div>
			{/if}
			{#if hasRuntimeState}
				<div>
					<span class="runtime-k">current price</span>
					<span class="runtime-v">{formatEthLabel(currentJob?.runtime?.currentPriceEth ?? null)}</span>
				</div>
				<div>
					<span class="runtime-k">active order</span>
					<span class="runtime-v mono">{currentJob?.runtime?.activeOrderId ?? '-'}</span>
				</div>
				<div>
					<span class="runtime-k">last run</span>
					<span class="runtime-v mono">{currentJob?.runtime?.lastRunAt ?? '-'}</span>
				</div>
			{/if}
		</div>
		{#if currentJob?.runtime?.lastError}
			<p class="runtime-error token-bidding-feedback" role="alert">{currentJob.runtime.lastError}</p>
		{/if}

		<form
			class="bootstrap-form token-bidding-form"
			onsubmit={(event) => {
				event.preventDefault();
				void handleSave();
			}}
		>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-status"><span>status</span></label>
				<select
					id="bidding-automation-status"
					class="bootstrap-control bootstrap-input-select-short"
					bind:value={status}
					disabled={saving || archiving}
				>
					<option value="enabled">enabled</option>
					<option value="paused">paused</option>
				</select>
			</div>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-floor"><span>floor ETH</span></label>
				<input
					id="bidding-automation-floor"
					class="bootstrap-control bidding-token-input"
					type="text"
					inputmode="decimal"
					bind:value={floorEth}
					disabled={saving || archiving}
				/>
			</div>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-ceiling"><span>ceiling ETH</span></label>
				<input
					id="bidding-automation-ceiling"
					class="bootstrap-control bidding-token-input"
					type="text"
					inputmode="decimal"
					bind:value={ceilingEth}
					disabled={saving || archiving}
				/>
			</div>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-delta"><span>delta ETH</span></label>
				<input
					id="bidding-automation-delta"
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
							saving...
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
							{archiving ? 'archiving...' : 'archive'}
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
	</div>
{/if}
