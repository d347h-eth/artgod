<script lang="ts">
	import {
		TRADING_BIDDING_TIER_SELECTION_MODE,
		TRADING_JOB_STATUS,
		TRADING_JOB_TARGET_KIND
	} from '@artgod/shared/types';
	import type {
		ApiBiddingBidBook,
		ApiBiddingCollectionSettings,
		ApiBiddingJob,
		ApiBiddingPriceTier,
		ApiChain,
		ApiCollection,
		ApiTokenDetail
	} from '$lib/api-types';
	import {
		archiveBiddingAutomationJob,
		hasSubmittableBiddingTarget,
		lookupBiddingAutomationDraftTargetJob,
		resolveBiddingAutomationDraftTargetLookupKey,
		resolveBiddingSaveMessage,
		saveBiddingAutomationDraftJobs,
		type BiddingAutomationPricingRequest,
		type EditableBiddingJobStatus
	} from '$lib/bidding-automation-panel-actions';
	import {
		hasBiddingAutomationPanelDraftChanges,
		resolveBiddingAutomationPanelJob,
		resolveInitialBiddingAutomationCeilingEth,
		resolveInitialBiddingAutomationDeltaEth,
		resolveInitialBiddingAutomationFloorEth,
		resolveInitialBiddingAutomationPriceTierId,
		resolveInitialBiddingAutomationPricingMode,
		resolveInitialBiddingAutomationStatus,
		resolveBiddingAutomationPanelDraftIdentityKey,
		resolveBiddingAutomationPanelTargetLookupRequestKey,
		resolveLoadedBiddingAutomationPanelKey,
		shouldPreserveBiddingAutomationPanelDraftOnLoadChange
	} from '$lib/bidding-automation-panel-state';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import { ownBiddingJobStateBadges } from '$lib/bidding-bid-book-own-status';
	import {
		BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
		BIDDING_AUTOMATION_PRICING_MODE,
		BIDDING_AUTOMATION_PRICING_MODE_LABEL,
		biddingAutomationDraftTokenId,
		isBiddingAutomationDraftSubmittable,
		type BiddingAutomationDraft,
		type BiddingAutomationPricingMode
	} from '$lib/bidding-automation';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import PlaceBidIcon from '$lib/components/PlaceBidIcon.svelte';
	import { TEST_IDS } from '$lib/test-ids';

	type ConfirmableBiddingAction = 'create' | 'modify' | 'activate' | 'pause' | 'archive';

	let {
		open,
		chain,
		collection,
		token,
		job,
		draft = null,
		bidBook = null,
		biddingSettings = defaultBiddingCollectionSettings(),
		priceTiers = [],
		expandSignal = 0,
		showCollapsedLauncher = true,
		onClose = null,
		onJobChange = null,
		onJobsChange = null
	}: {
		open: boolean;
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenDetail | null;
		job: ApiBiddingJob | null;
		draft?: BiddingAutomationDraft | null;
		bidBook?: ApiBiddingBidBook | null;
		biddingSettings?: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
		expandSignal?: number;
		showCollapsedLauncher?: boolean;
		onClose?: (() => void) | null;
		onJobChange?: ((job: ApiBiddingJob | null) => void) | null;
		onJobsChange?: ((jobs: ApiBiddingJob[]) => void) | null;
	} = $props();

	const initialPanelJob = resolveBiddingAutomationPanelJob({ job, draft, lookedUpJob: null });
	let currentJob = $state<ApiBiddingJob | null>(initialPanelJob);
	let loadedJobKey = $state(resolveLoadedBiddingAutomationPanelKey({ job, draft, lookedUpJob: null }));
	let loadedDraftKey = $state(resolveBiddingAutomationPanelDraftIdentityKey(draft));
	let pricingMode = $state<BiddingAutomationPricingMode>(
		resolveInitialBiddingAutomationPricingMode({ job: initialPanelJob, draft })
	);
	let selectedPriceTierId = $state(resolveInitialBiddingAutomationPriceTierId({ job: initialPanelJob, draft }));
	let status = $state<EditableBiddingJobStatus>(resolveInitialBiddingAutomationStatus(initialPanelJob));
	let floorEth = $state(resolveInitialBiddingAutomationFloorEth({ job: initialPanelJob, draft }));
	let ceilingEth = $state(resolveInitialBiddingAutomationCeilingEth({ job: initialPanelJob, draft }));
	let deltaEth = $state(
		resolveInitialBiddingAutomationDeltaEth({
			job: initialPanelJob,
			draft,
			defaultDeltaEth: biddingSettings.defaultDeltaEth
		})
	);
	let saving = $state(false);
	let archiving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let panelCollapsed = $state(false);
	let lastExpandSignal = $state(expandSignal);
	let armedAction = $state<ConfirmableBiddingAction | null>(null);
	let targetLookupKey = $state('');
	let targetLookupRequestKey = $state('');
	let targetLookupJob = $state<ApiBiddingJob | null>(null);
	let draftInputTouched = $state(false);

	const hasExistingJob = $derived(currentJob !== null);
	const selectedDraftUnsupported = $derived(!isBiddingAutomationDraftSubmittable(draft));
	const selectedDraftUnsupportedMessage = $derived(resolveSelectedDraftUnsupportedMessage());
	const bidStateBadges = $derived(ownBiddingJobStateBadges(currentJob, bidBook));
	const targetTokenId = $derived(biddingAutomationDraftTokenId(draft) ?? token?.tokenId ?? null);
	const selectedPriceTier = $derived(resolveSelectedPriceTier());
	const displayedFloorEth = $derived(
		pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier
			? (selectedPriceTier?.resolvedFloorEth ?? currentJob?.config.floorEth ?? '')
			: floorEth
	);
	const displayedCeilingEth = $derived(
		pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier
			? (selectedPriceTier?.resolvedCeilingEth ?? currentJob?.config.ceilingEth ?? '')
			: ceilingEth
	);
	const displayedDeltaEth = $derived(
		pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier
			? (selectedPriceTier?.deltaEth ?? currentJob?.config.deltaEth ?? '')
			: deltaEth
	);
	const pricingAvailable = $derived(
		pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Manual ||
			(!!selectedPriceTier && !!displayedFloorEth && !!displayedCeilingEth && !!displayedDeltaEth)
	);
	const priceInputsComplete = $derived(
		displayedFloorEth.trim().length > 0 &&
			displayedCeilingEth.trim().length > 0 &&
			displayedDeltaEth.trim().length > 0
	);
	const hasDraftChanges = $derived(
		hasBiddingAutomationPanelDraftChanges({
			currentJob,
			status,
			pricingMode,
			selectedPriceTierId,
			displayedFloorEth,
			displayedCeilingEth,
			displayedDeltaEth,
			floorEth,
			ceilingEth,
			deltaEth
		})
	);
	const canSubmitDraft = $derived(
		!!chain &&
			!!collection &&
			!selectedDraftUnsupported &&
			hasSubmittableBiddingTarget({ draft, targetTokenId }) &&
			pricingAvailable &&
			priceInputsComplete
	);
	const isEnabledJob = $derived(currentJob?.status === TRADING_JOB_STATUS.Enabled);
	const isPausedJob = $derived(currentJob?.status === TRADING_JOB_STATUS.Paused);
	const canResetDraft = $derived(!saving && !archiving && hasDraftChanges);
	const canCreateJob = $derived(!hasExistingJob && !saving && !archiving && canSubmitDraft);
	const canModifyJob = $derived(hasExistingJob && !saving && !archiving && hasDraftChanges && canSubmitDraft);
	const canPauseJob = $derived(isEnabledJob && !saving && !archiving && canSubmitDraft);
	const canActivateJob = $derived(isPausedJob && !saving && !archiving && canSubmitDraft);
	const canArchiveJob = $derived(
		!!currentJob &&
			(isEnabledJob || isPausedJob) &&
			!saving &&
			!archiving &&
			!!chain &&
			!!collection
	);

	$effect(() => {
		const nextLoadedJobKey = resolveLoadedBiddingAutomationPanelKey({
			job,
			draft,
			lookedUpJob: targetLookupJob
		});
		if (nextLoadedJobKey === loadedJobKey) {
			return;
		}

		const nextLoadedDraftKey = resolveBiddingAutomationPanelDraftIdentityKey(draft);
		const sameDraftTarget = nextLoadedDraftKey === loadedDraftKey;
		const nextJob = resolveBiddingAutomationPanelJob({
			job,
			draft,
			lookedUpJob: targetLookupJob
		});
		loadedJobKey = nextLoadedJobKey;
		loadedDraftKey = nextLoadedDraftKey;
		if (
			sameDraftTarget &&
			shouldPreserveBiddingAutomationPanelDraftOnLoadChange({
				draftInputTouched,
				saving,
				archiving
			})
		) {
			currentJob = nextJob;
			return;
		}

		applyLoadedPanel(nextJob, draft);
		saving = false;
		archiving = false;
		saveMessage = null;
		saveError = null;
		armedAction = null;
	});

	$effect(() => {
		void refreshTargetLookupJob();
	});

	$effect(() => {
		if (expandSignal === lastExpandSignal) {
			return;
		}
		lastExpandSignal = expandSignal;
		if (open) {
			panelCollapsed = false;
		}
	});

	function resetDraft(): void {
		applyDraft(currentJob, draft);
		draftInputTouched = false;
		saveMessage = null;
		saveError = null;
		armedAction = null;
	}

	function hidePanel(): void {
		if (!showCollapsedLauncher) {
			onClose?.();
			return;
		}
		panelCollapsed = true;
	}

	function showPanel(): void {
		panelCollapsed = false;
	}

	function togglePanelCollapsed(): void {
		panelCollapsed = !panelCollapsed;
	}

	function onWindowPointerDown(event: PointerEvent): void {
		clearArmedActionUnlessTarget(event.target);
	}

	function onWindowFocusIn(event: FocusEvent): void {
		clearArmedActionUnlessTarget(event.target);
	}

	function clearArmedActionUnlessTarget(target: EventTarget | null): void {
		if (!armedAction || isArmedActionTarget(target, armedAction)) {
			return;
		}
		armedAction = null;
	}

	function isArmedActionTarget(
		target: EventTarget | null,
		action: ConfirmableBiddingAction
	): boolean {
		return target instanceof HTMLElement
			? target.closest(`[data-bidding-action="${action}"]`) !== null
			: false;
	}

	async function confirmBiddingAction(
		action: ConfirmableBiddingAction,
		run: () => Promise<void>
	): Promise<void> {
		if (armedAction !== action) {
			armedAction = action;
			return;
		}
		armedAction = null;
		await run();
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (!open || event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isKeyboardTextEntryTarget(event.target, { allowCheckboxAndRadio: true })) return;

		const key = event.key.toLowerCase();
		if (key === 'b') {
			event.preventDefault();
			togglePanelCollapsed();
			return;
		}
		if (key === 'c' && onClose) {
			event.preventDefault();
			onClose();
		}
	}

	function applyLoadedPanel(
		resolvedJob: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): void {
		currentJob = resolvedJob;
		applyDraft(currentJob, currentDraft);
		draftInputTouched = false;
	}

	async function refreshTargetLookupJob(): Promise<void> {
		const nextLookupKey = resolveBiddingAutomationDraftTargetLookupKey({
			chain,
			collection,
			draft
		});
		const nextLookupRequestKey = resolveBiddingAutomationPanelTargetLookupRequestKey({
			targetLookupKey: nextLookupKey,
			bidBook
		});
		if (nextLookupRequestKey === targetLookupRequestKey) {
			return;
		}
		if (nextLookupKey !== targetLookupKey) {
			targetLookupJob = null;
		}
		targetLookupKey = nextLookupKey;
		targetLookupRequestKey = nextLookupRequestKey;
		if (!nextLookupKey) {
			return;
		}

		try {
			// Ask the backend if this draft target already has a declared job.
			const lookedUpJob = await lookupBiddingAutomationDraftTargetJob({
				fetchFn: fetch,
				chain,
				collection,
				draft
			});
			if (
				targetLookupKey === nextLookupKey &&
				targetLookupRequestKey === nextLookupRequestKey
			) {
				targetLookupJob = lookedUpJob;
			}
		} catch (error) {
			if (
				targetLookupKey === nextLookupKey &&
				targetLookupRequestKey === nextLookupRequestKey
			) {
				saveError = error instanceof Error ? error.message : 'failed to look up bidding job';
			}
		}
	}

	function applyDraft(value: ApiBiddingJob | null, currentDraft: BiddingAutomationDraft | null): void {
		pricingMode = resolveInitialBiddingAutomationPricingMode({
			job: value,
			draft: currentDraft
		});
		selectedPriceTierId = resolveInitialBiddingAutomationPriceTierId({
			job: value,
			draft: currentDraft
		});
		status = resolveInitialBiddingAutomationStatus(value);
		floorEth = resolveInitialBiddingAutomationFloorEth({
			job: value,
			draft: currentDraft
		});
		ceilingEth = resolveInitialBiddingAutomationCeilingEth({
			job: value,
			draft: currentDraft
		});
		deltaEth = resolveInitialBiddingAutomationDeltaEth({
			job: value,
			draft: currentDraft,
			defaultDeltaEth: biddingSettings.defaultDeltaEth
		});
	}

	function resolveSelectedPriceTier(): ApiBiddingPriceTier | null {
		if (!selectedPriceTierId) {
			return null;
		}
		return priceTiers.find((tier) => tier.tierId === selectedPriceTierId) ?? null;
	}

	function pricingSelectionValue(): string {
		return pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier && selectedPriceTierId
			? selectedPriceTierId
			: BIDDING_AUTOMATION_PRICING_MODE.Manual;
	}

	function onPricingSelectionChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) {
			return;
		}
		markDraftInputTouched();
		selectPricingOption(target.value);
	}

	function selectPricingOption(value: string): void {
		if (value === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			selectManualPricing();
			return;
		}
		selectTierPricing(value);
	}

	function selectManualPricing(): void {
		markDraftInputTouched();
		if (pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
			floorEth = displayedFloorEth;
			ceilingEth = displayedCeilingEth;
			deltaEth = displayedDeltaEth;
		}
		pricingMode = BIDDING_AUTOMATION_PRICING_MODE.Manual;
		selectedPriceTierId = '';
	}

	function selectTierPricing(tierId: string): void {
		const tier = priceTiers.find((candidate) => candidate.tierId === tierId);
		if (!tier) {
			return;
		}
		markDraftInputTouched();
		pricingMode = BIDDING_AUTOMATION_PRICING_MODE.Tier;
		selectedPriceTierId = tier.tierId;
		floorEth = tier.resolvedFloorEth ?? floorEth;
		ceilingEth = tier.resolvedCeilingEth ?? ceilingEth;
		deltaEth = tier.deltaEth;
	}

	function markDraftInputTouched(): void {
		draftInputTouched = true;
	}

	function tierButtonTitle(tier: ApiBiddingPriceTier): string {
		const trimmed = tier.name.trim();
		return trimmed.length <= 100 ? trimmed : `${trimmed.slice(0, 97)}...`;
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
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob) {
			return draft.target.traits
				.map((trait) => `${trimTargetText(trait.key)}=${trimTargetText(trait.value)}`)
				.join(' + ');
		}
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
			return `${draft.target.tokenCount} filtered tokens`;
		}
		return 'collection';
	}

	function resolveSelectedDraftUnsupportedMessage(): string {
		if (draft?.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob) {
			return 'selected trait target is not available for marketplace bidding';
		}
		return 'selected bidding target is not available';
	}

	function trimTargetText(value: string): string {
		const maxLength = 96;
		const trimmed = value.trim();
		return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
	}

	async function handleSave(statusOverride: EditableBiddingJobStatus | null = null): Promise<void> {
		if (!chain || !collection || selectedDraftUnsupported || saving || archiving || !canSubmitDraft) {
			return;
		}
		if (statusOverride === null && hasExistingJob && !canModifyJob) {
			return;
		}
		if (statusOverride === null && !hasExistingJob && !canCreateJob) {
			return;
		}
		if (statusOverride === TRADING_JOB_STATUS.Paused && !canPauseJob) {
			return;
		}
		if (statusOverride === TRADING_JOB_STATUS.Enabled && hasExistingJob && !canActivateJob) {
			return;
		}

		const nextStatus = statusOverride ?? status;
		const wasExistingJob = currentJob !== null;
		armedAction = null;
		saving = true;
		saveMessage = null;
		saveError = null;

		try {
			// Persist the draft through the matching backend job mutation adapter.
			const changedJobs = await saveBiddingAutomationDraftJobs({
				fetchFn: fetch,
				chainRef: chain.slug,
				collectionRef: collection.slug,
				draft,
				targetTokenId,
				nextStatus,
				pricing: pricingRequestBody()
			});
			currentJob = changedJobs.length === 1 ? changedJobs[0] : currentJob;
			notifyJobsChanged(changedJobs);
			resetDraft();
			saveMessage =
				statusOverride === TRADING_JOB_STATUS.Paused
					? 'paused'
					: statusOverride === TRADING_JOB_STATUS.Enabled && wasExistingJob
						? 'activated'
						: resolveBiddingSaveMessage(changedJobs.length, wasExistingJob);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to save bidding job';
		} finally {
			saving = false;
		}
	}

	function pricingRequestBody(): BiddingAutomationPricingRequest {
		return pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier
			? { priceTierId: selectedPriceTierId, deltaEth: displayedDeltaEth.trim() }
			: {
					floorEth: floorEth.trim(),
					ceilingEth: ceilingEth.trim(),
					deltaEth: deltaEth.trim(),
					priceTierId: null
				};
	}

	function notifyJobsChanged(jobs: ApiBiddingJob[]): void {
		if (jobs.length === 1 && jobs[0].target.type === TRADING_JOB_TARGET_KIND.Token) {
			onJobChange?.(jobs[0]);
		}
		onJobsChange?.(jobs);
	}

	async function handleArchive(): Promise<void> {
		if (
			!canArchiveJob ||
			!chain ||
			!collection ||
			!currentJob ||
			saving ||
			archiving
		) {
			return;
		}

		archiving = true;
		armedAction = null;
		saveMessage = null;
		saveError = null;

		try {
			// Archive the declared bidding job through the target-agnostic backend adapter.
			const archivedJob = await archiveBiddingAutomationJob({
				fetchFn: fetch,
				chainRef: chain.slug,
				collectionRef: collection.slug,
				jobId: currentJob.jobId
			});
			currentJob = null;
			if (archivedJob.target.type === TRADING_JOB_TARGET_KIND.Token) {
				onJobChange?.(null);
			}
			onJobsChange?.([archivedJob]);
			resetDraft();
			saveMessage = 'archived';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to archive bidding job';
		} finally {
			archiving = false;
		}
	}
</script>

<svelte:window
	onkeydown={onWindowKeydown}
	onpointerdown={onWindowPointerDown}
	onfocusin={onWindowFocusIn}
/>

{#if open && panelCollapsed && showCollapsedLauncher}
	<button
		type="button"
		class="bidding-automation-panel-collapsed"
		aria-label="show bidding panel"
		title="show bidding panel"
		onclick={showPanel}
	>
		<PlaceBidIcon className="bidding-automation-panel-collapsed-icon" />
	</button>
{:else if open && !panelCollapsed}
	<div
		class="runtime-section bidding-automation-panel"
		data-testid={TEST_IDS.BiddingPanel}
		role="dialog"
		aria-label="bidding automation"
	>
		<header class="panel-header bidding-automation-panel-header">
			<h2 class="panel-title">bidding</h2>
			<button type="button" class="button-link" onclick={hidePanel}>hide</button>
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
					<span class="runtime-k">job</span>
					<span class="runtime-v mono">{currentJob.jobId}</span>
				</div>
			{/if}
			{#if bidStateBadges.length > 0}
				<div>
					<span class="runtime-k">state</span>
					<span class="runtime-v token-bidding-state-badges">
						{#each bidStateBadges as badge (`${badge.kind}:${badge.label}`)}
							<span class={`bid-book-own-status bid-book-own-status-${badge.kind}`}>
								{badge.label}
							</span>
						{/each}
					</span>
				</div>
			{/if}
		</div>
		{#if currentJob?.runtime?.lastError}
			<p class="runtime-error token-bidding-feedback" role="alert">{currentJob.runtime.lastError}</p>
		{/if}

		{#if selectedDraftUnsupported}
			<p class="runtime-error token-bidding-feedback" role="alert">
				{selectedDraftUnsupportedMessage}
			</p>
		{:else}
			<form
				class="bootstrap-form token-bidding-form"
				onsubmit={(event) => {
					event.preventDefault();
				}}
			>
			<div class="bootstrap-form-row token-bidding-pricing-row">
				<label for="bidding-automation-pricing-select"><span>pricing</span></label>
				{#if biddingSettings.tierSelectionMode === TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown}
					<select
						id="bidding-automation-pricing-select"
						class="bootstrap-control bootstrap-input-select-medium"
						value={pricingSelectionValue()}
						onchange={onPricingSelectionChange}
						disabled={saving || archiving || selectedDraftUnsupported}
					>
						<option value={BIDDING_AUTOMATION_PRICING_MODE.Manual}>
							{BIDDING_AUTOMATION_PRICING_MODE_LABEL[BIDDING_AUTOMATION_PRICING_MODE.Manual]}
						</option>
						{#each priceTiers as tier}
							<option value={tier.tierId}>{tier.name}</option>
						{/each}
					</select>
				{:else}
					<div
						id="bidding-automation-pricing-select"
						class="secondary-tabs token-bidding-pricing-options"
						aria-label="Pricing"
					>
						<button
							type="button"
							class:secondary-tab-active={pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Manual}
							aria-pressed={pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Manual}
							disabled={saving || archiving || selectedDraftUnsupported}
							onclick={selectManualPricing}
							title={BIDDING_AUTOMATION_PRICING_MODE_LABEL[BIDDING_AUTOMATION_PRICING_MODE.Manual]}
						>
							{BIDDING_AUTOMATION_PRICING_MODE_LABEL[BIDDING_AUTOMATION_PRICING_MODE.Manual]}
						</button>
						{#each priceTiers as tier}
							<button
								type="button"
								class:secondary-tab-active={pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier &&
									selectedPriceTierId === tier.tierId}
								aria-pressed={pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier &&
									selectedPriceTierId === tier.tierId}
								disabled={saving || archiving || selectedDraftUnsupported}
								onclick={() => selectTierPricing(tier.tierId)}
								title={tierButtonTitle(tier)}
							>
								{tier.name}
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-floor"><span>floor ETH</span></label>
				{#if pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier}
					<input
						id="bidding-automation-floor"
						class="bootstrap-control bidding-token-input"
						type="text"
						value={displayedFloorEth}
						disabled
					/>
				{:else}
					<input
						id="bidding-automation-floor"
						class="bootstrap-control bidding-token-input"
						type="text"
						inputmode="decimal"
						bind:value={floorEth}
						oninput={markDraftInputTouched}
						disabled={saving || archiving || selectedDraftUnsupported}
					/>
				{/if}
			</div>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-ceiling"><span>ceiling ETH</span></label>
				{#if pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier}
					<input
						id="bidding-automation-ceiling"
						class="bootstrap-control bidding-token-input"
						type="text"
						value={displayedCeilingEth}
						disabled
					/>
				{:else}
					<input
						id="bidding-automation-ceiling"
						class="bootstrap-control bidding-token-input"
						type="text"
						inputmode="decimal"
						bind:value={ceilingEth}
						oninput={markDraftInputTouched}
						disabled={saving || archiving || selectedDraftUnsupported}
					/>
				{/if}
			</div>
			<div class="bootstrap-form-row">
				<label for="bidding-automation-delta"><span>delta ETH</span></label>
				<input
					id="bidding-automation-delta"
					class="bootstrap-control bidding-token-input"
					type="text"
					inputmode="decimal"
					value={displayedDeltaEth}
					oninput={(event) => {
						if (
							pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Manual &&
							event.currentTarget instanceof HTMLInputElement
						) {
							markDraftInputTouched();
							deltaEth = event.currentTarget.value;
						}
					}}
					disabled={pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier ||
						saving ||
						archiving ||
						selectedDraftUnsupported}
				/>
			</div>
			<div class="panel-footer token-bidding-form-footer">
				<div class="token-bidding-form-actions-left">
					<button type="button" onclick={resetDraft} disabled={!canResetDraft}>reset</button>
					{#if !hasExistingJob || isEnabledJob}
						<button
							type="button"
							class="token-bidding-action-negative"
							class:token-bidding-action-armed={armedAction === 'pause'}
							data-bidding-action="pause"
							data-testid={TEST_IDS.BiddingPanelPause}
							onclick={() =>
								void confirmBiddingAction('pause', () =>
									handleSave(TRADING_JOB_STATUS.Paused)
								)}
							disabled={!canPauseJob}
						>
							pause
						</button>
					{/if}
					<button
						type="button"
						class="token-bidding-action-negative"
						class:token-bidding-action-armed={armedAction === 'archive'}
						data-bidding-action="archive"
						data-testid={TEST_IDS.BiddingPanelArchive}
						onclick={() => void confirmBiddingAction('archive', handleArchive)}
						disabled={!canArchiveJob}
					>
						{archiving ? 'archiving...' : 'archive'}
					</button>
				</div>
				<div class="token-bidding-form-actions-right">
					{#if hasExistingJob}
						<button
							type="button"
							class="token-bidding-action-positive"
							class:token-bidding-action-armed={armedAction === 'modify'}
							data-bidding-action="modify"
							data-testid={TEST_IDS.BiddingPanelModify}
							onclick={() => void confirmBiddingAction('modify', () => handleSave())}
							disabled={!canModifyJob}
						>
							{saving ? 'saving...' : 'modify'}
						</button>
						{#if isPausedJob}
							<button
								type="button"
								class="token-bidding-action-positive"
								class:token-bidding-action-armed={armedAction === 'activate'}
								data-bidding-action="activate"
								data-testid={TEST_IDS.BiddingPanelActivate}
								onclick={() =>
									void confirmBiddingAction('activate', () =>
										handleSave(TRADING_JOB_STATUS.Enabled)
									)}
								disabled={!canActivateJob}
							>
								activate
							</button>
						{/if}
					{:else}
						<button
							type="button"
							class="token-bidding-action-positive"
							class:token-bidding-action-armed={armedAction === 'create'}
							data-bidding-action="create"
							data-testid={TEST_IDS.BiddingPanelCreate}
							onclick={() => void confirmBiddingAction('create', () => handleSave())}
							disabled={!canCreateJob}
						>
							{saving ? 'creating...' : 'create'}
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
		{/if}
	</div>
{/if}
