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
	import {
		BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
		BIDDING_AUTOMATION_PRICING_MODE,
		BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
		biddingAutomationDraftTokenId,
		isBiddingAutomationDraftSubmittable,
		type BiddingAutomationDraft
	} from '$lib/bidding-automation';

	type EditableTokenJobStatus = 'enabled' | 'paused';

	let {
		open,
		chain,
		collection,
		token,
		job,
		draft = null,
		bidBook = null,
		onClose,
		onJobChange = null
	}: {
		open: boolean;
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenDetail | null;
		job: ApiBiddingJob | null;
		draft?: BiddingAutomationDraft | null;
		bidBook?: ApiBiddingBidBook | null;
		onClose: () => void;
		onJobChange?: ((job: ApiBiddingJob | null) => void) | null;
	} = $props();

	const initialPanelJob = resolvePanelJob(job, draft);
	let currentJob = $state<ApiBiddingJob | null>(initialPanelJob);
	let loadedJobKey = $state(resolveLoadedPanelKey(job, draft));
	let status = $state<EditableTokenJobStatus>(resolveInitialStatus(initialPanelJob));
	let floorEth = $state(resolveInitialFloorEth(initialPanelJob, draft));
	let ceilingEth = $state(resolveInitialCeilingEth(initialPanelJob, draft));
	let deltaEth = $state(resolveInitialDeltaEth(initialPanelJob, draft));
	let saving = $state(false);
	let archiving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);

	const hasExistingJob = $derived(currentJob !== null);
	const hasRuntimeState = $derived(currentJob?.runtime !== null && currentJob?.runtime !== undefined);
	const selectedDraftUnsupported = $derived(!isBiddingAutomationDraftSubmittable(draft));
	const hasDraftChanges = $derived(resolveHasDraftChanges());
	const bidPosition = $derived(resolveBidPosition(currentJob, bidBook));
	const targetTokenId = $derived(biddingAutomationDraftTokenId(draft) ?? token?.tokenId ?? null);
	const canSubmitDraft = $derived(
		!!chain && !!collection && !!targetTokenId && !selectedDraftUnsupported
	);

	$effect(() => {
		const nextLoadedJobKey = resolveLoadedPanelKey(job, draft);
		if (nextLoadedJobKey === loadedJobKey) {
			return;
		}

		loadedJobKey = nextLoadedJobKey;
		applyLoadedPanel(job, draft);
		saving = false;
		archiving = false;
		saveMessage = null;
		saveError = null;
	});

	function resolvePanelJob(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): ApiBiddingJob | null {
		return currentDraft?.existingJob ?? value;
	}

	function resolveLoadedPanelKey(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		return `${resolveLoadedJobKey(resolvePanelJob(value, currentDraft))}:${resolveDraftKey(currentDraft)}`;
	}

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

	function resolveDraftKey(value: BiddingAutomationDraft | null): string {
		if (!value) {
			return 'no-draft';
		}
		return [
			value.source.type,
			value.source.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid
				? value.source.bid.orderId
				: '',
			value.target.type,
			biddingAutomationDraftTokenId(value) ?? '',
			value.pricing.mode,
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? value.pricing.floorEth : '',
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? value.pricing.ceilingEth : '',
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? value.pricing.deltaEth : ''
		].join(':');
	}

	function resolveInitialStatus(value: ApiBiddingJob | null): EditableTokenJobStatus {
		return value?.status === 'paused' ? 'paused' : 'enabled';
	}

	function resolveInitialFloorEth(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			return currentDraft.pricing.floorEth;
		}
		return value?.config.floorEth ?? '';
	}

	function resolveInitialCeilingEth(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			return currentDraft.pricing.ceilingEth;
		}
		return value?.config.ceilingEth ?? '';
	}

	function resolveInitialDeltaEth(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			return currentDraft.pricing.deltaEth;
		}
		return value?.config.deltaEth ?? '';
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
		applyDraft(currentJob, draft);
		saveMessage = null;
		saveError = null;
	}

	function applyLoadedPanel(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): void {
		currentJob = resolvePanelJob(value, currentDraft);
		applyDraft(currentJob, currentDraft);
	}

	function applyDraft(value: ApiBiddingJob | null, currentDraft: BiddingAutomationDraft | null): void {
		status = resolveInitialStatus(value);
		floorEth = resolveInitialFloorEth(value, currentDraft);
		ceilingEth = resolveInitialCeilingEth(value, currentDraft);
		deltaEth = resolveInitialDeltaEth(value, currentDraft);
	}

	function targetLabel(): string {
		if (!draft) {
			return targetTokenId ? `#${targetTokenId}` : '-';
		}
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
			return draft.target.tokenIds.length === 1
				? `#${draft.target.tokenIds[0]}`
				: `${draft.target.tokenIds.length} tokens`;
		}
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
			return draft.target.traits
				.map((trait) => `${trimTargetText(trait.key)}=${trimTargetText(trait.value)}`)
				.join(' + ');
		}
		return 'collection';
	}

	function trimTargetText(value: string): string {
		const maxLength = 96;
		const trimmed = value.trim();
		return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
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
		if (!chain || !collection || !targetTokenId || selectedDraftUnsupported || saving || archiving) {
			return;
		}

		const wasExistingJob = currentJob !== null;
		saving = true;
		saveMessage = null;
		saveError = null;

		try {
			// Persist the token-scoped bidding job through the backend CRUD adapter.
			const response = await upsertTokenBiddingJob(fetch, chain.slug, collection.slug, targetTokenId, {
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
		if (!chain || !collection || !targetTokenId || !currentJob || saving || archiving) {
			return;
		}

		if (typeof window !== 'undefined') {
			const confirmed = window.confirm(
				`Archive bidding job for token ${targetTokenId}? Active offer cleanup will be queued.`
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
			await archiveTokenBiddingJob(fetch, chain.slug, collection.slug, targetTokenId);
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
				<span class="runtime-v mono">{targetLabel()}</span>
			</div>
			{#if selectedDraftUnsupported}
				<div>
					<span class="runtime-k">submit</span>
					<span class="runtime-v">not available</span>
				</div>
			{/if}
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
					disabled={saving || archiving || selectedDraftUnsupported}
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
					disabled={saving || archiving || selectedDraftUnsupported}
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
					disabled={saving || archiving || selectedDraftUnsupported}
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
					disabled={saving || archiving || selectedDraftUnsupported}
				/>
			</div>
			<div class="panel-footer token-bidding-form-footer">
				<div class="token-bidding-form-actions">
					<button type="submit" disabled={saving || archiving || !hasDraftChanges || !canSubmitDraft}>
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
