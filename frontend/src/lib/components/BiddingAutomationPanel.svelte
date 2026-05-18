<script lang="ts">
	import {
		TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
		TRADING_BIDDING_TIER_SELECTION_MODE,
		TRADING_JOB_STATUS,
		TRADING_JOB_TARGET_KIND
	} from '@artgod/shared/types';
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingCollectionSettings,
		ApiBiddingJob,
		ApiBiddingPriceTier,
		ApiChain,
		ApiCollection,
		ApiTokenDetail
	} from '$lib/api-types';
	import {
		archiveBiddingJob,
		lookupBiddingJobTarget,
		upsertBatchTokenBiddingJobs,
		upsertCollectionBiddingJob,
		upsertTokenBiddingJob,
		upsertTraitBiddingJob
	} from '$lib/backend-api';
	import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
	import { bidBookRowEffectivePriceWei } from '$lib/bidding-bid-book-price';
	import {
		BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
		BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
		BIDDING_AUTOMATION_PRICING_MODE,
		BIDDING_AUTOMATION_PRICING_MODE_LABEL,
		BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
		BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
		biddingAutomationDraftTokenId,
		buildBiddingJobTargetLookupRequestBody,
		canSubmitFilteredTokenBatch,
		isBiddingAutomationDraftSubmittable,
		type BiddingAutomationDraft,
		type BiddingAutomationPricingMode
	} from '$lib/bidding-automation';
	import {
		formatCompactTime,
		oppositeCompactTimeTitle,
		parseCompactTimeMs,
		type CompactTimeDisplayMode
	} from '$lib/compact-time-display';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import PlaceBidIcon from '$lib/components/PlaceBidIcon.svelte';

	type EditableTokenJobStatus =
		| typeof TRADING_JOB_STATUS.Enabled
		| typeof TRADING_JOB_STATUS.Paused;
	type BiddingAutomationPanelVariant = 'floating' | 'inline';
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
		variant = 'floating',
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
		variant?: BiddingAutomationPanelVariant;
		onClose?: (() => void) | null;
		onJobChange?: ((job: ApiBiddingJob | null) => void) | null;
		onJobsChange?: ((jobs: ApiBiddingJob[]) => void) | null;
	} = $props();

	const initialPanelJob = resolvePanelJob(job, draft, null);
	let currentJob = $state<ApiBiddingJob | null>(initialPanelJob);
	let loadedJobKey = $state(resolveLoadedPanelKey(job, draft, null));
	let pricingMode = $state<BiddingAutomationPricingMode>(
		resolveInitialPricingMode(initialPanelJob, draft)
	);
	let selectedPriceTierId = $state(resolveInitialPriceTierId(initialPanelJob, draft));
	let status = $state<EditableTokenJobStatus>(resolveInitialStatus(initialPanelJob));
	let floorEth = $state(resolveInitialFloorEth(initialPanelJob, draft));
	let ceilingEth = $state(resolveInitialCeilingEth(initialPanelJob, draft));
	let deltaEth = $state(resolveInitialDeltaEth(initialPanelJob, draft));
	let saving = $state(false);
	let archiving = $state(false);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let panelCollapsed = $state(false);
	let lastExpandSignal = $state(expandSignal);
	let modifiedAtMode = $state<CompactTimeDisplayMode>('relative');
	let refreshedAtMode = $state<CompactTimeDisplayMode>('relative');
	let nowMs = $state(Date.now());
	let armedAction = $state<ConfirmableBiddingAction | null>(null);
	let targetLookupKey = $state('');
	let targetLookupJob = $state<ApiBiddingJob | null>(null);

	const hasExistingJob = $derived(currentJob !== null);
	const hasRuntimeState = $derived(currentJob?.runtime !== null && currentJob?.runtime !== undefined);
	const selectedDraftUnsupported = $derived(!isBiddingAutomationDraftSubmittable(draft));
	const bidPosition = $derived(resolveBidPosition(currentJob, bidBook));
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
	const hasDraftChanges = $derived(resolveHasDraftChanges());
	const canSubmitDraft = $derived(
		!!chain &&
			!!collection &&
			!selectedDraftUnsupported &&
			hasSubmittableTarget() &&
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
	const modifiedAtMs = $derived(parseCompactTimeMs(currentJob?.updatedAt));
	const refreshedAtMs = $derived(
		parseCompactTimeMs(currentJob?.runtime?.updatedAt ?? currentJob?.runtime?.lastRunAt)
	);

	$effect(() => {
		const timer = window.setInterval(() => {
			nowMs = Date.now();
		}, 60_000);
		return () => window.clearInterval(timer);
	});

	$effect(() => {
		const nextLoadedJobKey = resolveLoadedPanelKey(job, draft, targetLookupJob);
		if (nextLoadedJobKey === loadedJobKey) {
			return;
		}

		loadedJobKey = nextLoadedJobKey;
		applyLoadedPanel(job, draft, targetLookupJob);
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

	function resolvePanelJob(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null,
		lookedUpJob: ApiBiddingJob | null
	): ApiBiddingJob | null {
		return currentDraft?.existingJob ?? lookedUpJob ?? value;
	}

	function resolveLoadedPanelKey(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null,
		lookedUpJob: ApiBiddingJob | null
	): string {
		return `${resolveLoadedJobKey(resolvePanelJob(value, currentDraft, lookedUpJob))}:${resolveDraftKey(currentDraft)}`;
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
			value.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch
				? value.target.tokenCount
				: '',
			value.pricing.mode,
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? value.pricing.floorEth : '',
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? value.pricing.ceilingEth : '',
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual ? value.pricing.deltaEth : '',
			value.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier ? value.pricing.tierId : ''
		].join(':');
	}

	function resolveInitialPricingMode(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): BiddingAutomationPricingMode {
		if (value?.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier) {
			return BIDDING_AUTOMATION_PRICING_MODE.Tier;
		}
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
			return BIDDING_AUTOMATION_PRICING_MODE.Tier;
		}
		return BIDDING_AUTOMATION_PRICING_MODE.Manual;
	}

	function resolveInitialPriceTierId(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (value?.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier) {
			return value.config.pricingSource.tierId;
		}
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
			return currentDraft.pricing.tierId;
		}
		return '';
	}

	function resolveInitialStatus(value: ApiBiddingJob | null): EditableTokenJobStatus {
		return value?.status === TRADING_JOB_STATUS.Paused
			? TRADING_JOB_STATUS.Paused
			: TRADING_JOB_STATUS.Enabled;
	}

	function resolveInitialFloorEth(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (value?.config.floorEth) {
			return value.config.floorEth;
		}
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			return currentDraft.pricing.floorEth;
		}
		return '';
	}

	function resolveInitialCeilingEth(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (value?.config.ceilingEth) {
			return value.config.ceilingEth;
		}
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			return currentDraft.pricing.ceilingEth;
		}
		return '';
	}

	function resolveInitialDeltaEth(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): string {
		if (value?.config.deltaEth) {
			return value.config.deltaEth;
		}
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Manual) {
			return currentDraft.pricing.deltaEth || biddingSettings.defaultDeltaEth;
		}
		if (currentDraft?.pricing.mode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
			return currentDraft.pricing.deltaEth;
		}
		return biddingSettings.defaultDeltaEth;
	}

	function resolveHasDraftChanges(): boolean {
		if (currentJob) {
			if (pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier) {
				return (
					status !== resolveInitialStatus(currentJob) ||
					selectedPriceTierId !== jobPriceTierId(currentJob) ||
					displayedFloorEth.trim() !== currentJob.config.floorEth ||
					displayedCeilingEth.trim() !== currentJob.config.ceilingEth ||
					displayedDeltaEth.trim() !== currentJob.config.deltaEth
				);
			}
			return (
				status !== resolveInitialStatus(currentJob) ||
				currentJob.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier ||
				floorEth.trim() !== currentJob.config.floorEth ||
				ceilingEth.trim() !== currentJob.config.ceilingEth ||
				deltaEth.trim() !== currentJob.config.deltaEth
			);
		}

		return (
			status !== TRADING_JOB_STATUS.Enabled ||
			pricingMode !== BIDDING_AUTOMATION_PRICING_MODE.Manual ||
			displayedFloorEth.trim().length > 0 ||
			displayedCeilingEth.trim().length > 0 ||
			deltaEth.trim().length > 0
		);
	}

	function resetDraft(): void {
		applyDraft(currentJob, draft);
		saveMessage = null;
		saveError = null;
		armedAction = null;
	}

	function hidePanel(): void {
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
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null,
		lookedUpJob: ApiBiddingJob | null
	): void {
		currentJob = resolvePanelJob(value, currentDraft, lookedUpJob);
		applyDraft(currentJob, currentDraft);
	}

	async function refreshTargetLookupJob(): Promise<void> {
		if (!chain || !collection || !draft || draft.existingJob) {
			targetLookupKey = '';
			targetLookupJob = null;
			return;
		}

		const body = buildBiddingJobTargetLookupRequestBody(draft);
		if (!body) {
			targetLookupKey = '';
			targetLookupJob = null;
			return;
		}

		const nextLookupKey = `${chain.slug}:${collection.slug}:${JSON.stringify(body)}`;
		if (nextLookupKey === targetLookupKey) {
			return;
		}
		targetLookupKey = nextLookupKey;
		targetLookupJob = null;

		try {
			// Ask the backend if this draft target already has a declared job.
			const response = await lookupBiddingJobTarget(fetch, chain.slug, collection.slug, body);
			if (targetLookupKey === nextLookupKey) {
				targetLookupJob = response.job;
			}
		} catch (error) {
			if (targetLookupKey === nextLookupKey) {
				saveError = error instanceof Error ? error.message : 'failed to look up bidding job';
			}
		}
	}

	function applyDraft(value: ApiBiddingJob | null, currentDraft: BiddingAutomationDraft | null): void {
		pricingMode = resolveInitialPricingMode(value, currentDraft);
		selectedPriceTierId = resolveInitialPriceTierId(value, currentDraft);
		status = resolveInitialStatus(value);
		floorEth = resolveInitialFloorEth(value, currentDraft);
		ceilingEth = resolveInitialCeilingEth(value, currentDraft);
		deltaEth = resolveInitialDeltaEth(value, currentDraft);
	}

	function resolveSelectedPriceTier(): ApiBiddingPriceTier | null {
		if (!selectedPriceTierId) {
			return null;
		}
		return priceTiers.find((tier) => tier.tierId === selectedPriceTierId) ?? null;
	}

	function jobPriceTierId(value: ApiBiddingJob): string | null {
		return value.config.pricingSource?.kind === TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier
			? value.config.pricingSource.tierId
			: null;
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
		pricingMode = BIDDING_AUTOMATION_PRICING_MODE.Tier;
		selectedPriceTierId = tier.tierId;
		floorEth = tier.resolvedFloorEth ?? floorEth;
		ceilingEth = tier.resolvedCeilingEth ?? ceilingEth;
		deltaEth = tier.deltaEth;
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
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
			return `${draft.target.tokenCount} filtered tokens`;
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

	function formatJobTime(valueMs: number | null, mode: CompactTimeDisplayMode): string {
		return formatCompactTime(valueMs, mode, nowMs);
	}

	function jobTimeTitle(valueMs: number | null, mode: CompactTimeDisplayMode): string | undefined {
		return oppositeCompactTimeTitle(valueMs, mode, nowMs);
	}

	function toggleModifiedAtMode(): void {
		modifiedAtMode = modifiedAtMode === 'relative' ? 'absolute' : 'relative';
	}

	function toggleRefreshedAtMode(): void {
		refreshedAtMode = refreshedAtMode === 'relative' ? 'absolute' : 'relative';
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
		if (
			!opponentBid ||
			bidBookRowEffectivePriceWei(ownBid) >= bidBookRowEffectivePriceWei(opponentBid)
		) {
			return 'winning';
		}
		return 'outbid';
	}

	function bestBid(
		bids: ApiBiddingBidBookRow[],
		predicate: (bid: ApiBiddingBidBookRow) => boolean
	): ApiBiddingBidBookRow | null {
		return bids.filter(predicate).sort((left, right) => {
			const leftPrice = bidBookRowEffectivePriceWei(left);
			const rightPrice = bidBookRowEffectivePriceWei(right);
			if (leftPrice === rightPrice) {
				return left.orderId.localeCompare(right.orderId);
			}
			return leftPrice > rightPrice ? -1 : 1;
		})[0] ?? null;
	}

	async function handleSave(statusOverride: EditableTokenJobStatus | null = null): Promise<void> {
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
			const changedJobs = await saveDraftJobs(chain.slug, collection.slug, nextStatus);
			currentJob = changedJobs.length === 1 ? changedJobs[0] : currentJob;
			notifyJobsChanged(changedJobs);
			resetDraft();
			saveMessage =
				statusOverride === TRADING_JOB_STATUS.Paused
					? 'paused'
					: statusOverride === TRADING_JOB_STATUS.Enabled && wasExistingJob
						? 'activated'
						: resolveSaveMessage(changedJobs.length, wasExistingJob);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to save bidding job';
		} finally {
			saving = false;
		}
	}

	async function saveDraftJobs(
		chainRef: string,
		collectionRef: string,
		nextStatus: EditableTokenJobStatus
	): Promise<ApiBiddingJob[]> {
		const pricingBody = pricingRequestBody();
		if (!draft) {
			if (!targetTokenId) {
				throw new Error('target token is required');
			}
			const response = await upsertTokenBiddingJob(fetch, chainRef, collectionRef, targetTokenId, {
				status: nextStatus,
				...pricingBody
			});
			return [response.job];
		}

		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
			if (draft.target.tokenIds.length === 1) {
				const response = await upsertTokenBiddingJob(
					fetch,
					chainRef,
					collectionRef,
					draft.target.tokenIds[0],
					{
						status: nextStatus,
						...pricingBody
					}
				);
				return [response.job];
			}
			const response = await upsertBatchTokenBiddingJobs(fetch, chainRef, collectionRef, {
				status: nextStatus,
				...pricingBody,
				selection: {
					type: 'token_ids',
					tokenIds: draft.target.tokenIds
				}
			});
			return response.jobs;
		}

		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
			if (
				draft.source.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens ||
				!canSubmitFilteredTokenBatch(draft)
			) {
				throw new Error('filtered token selection is not available for submit');
			}
			if (draft.source.filter.source === BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers) {
				const response = await upsertBatchTokenBiddingJobs(fetch, chainRef, collectionRef, {
					status: nextStatus,
					...pricingBody,
					selection: {
						type: 'token_offer_filter',
						traits: draft.source.filter.selectedTraits,
						traitRanges: draft.source.filter.selectedTraitRanges,
						traitJoinMode: draft.source.filter.traitJoinMode,
						makerAddress: draft.source.filter.makerAddress
					}
				});
				return response.jobs;
			}
			const tokenStatus = draft.source.filter.tokenStatus;
			if (!tokenStatus) {
				throw new Error('filtered token selection is missing token status');
			}
			const response = await upsertBatchTokenBiddingJobs(fetch, chainRef, collectionRef, {
				status: nextStatus,
				...pricingBody,
				selection: {
					type: 'filter',
					tokenStatus,
					traits: draft.source.filter.selectedTraits,
					traitRanges: draft.source.filter.selectedTraitRanges
				}
			});
			return response.jobs;
		}

		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
			const response = await upsertTraitBiddingJob(fetch, chainRef, collectionRef, {
				status: nextStatus,
				...pricingBody,
				quantity: selectedBidQuantity(),
				targetTraits: draft.target.traits.map((trait) => ({
					type: trait.key,
					value: trait.value
				}))
			});
			return [response.job];
		}

		const response = await upsertCollectionBiddingJob(fetch, chainRef, collectionRef, {
			status: nextStatus,
			...pricingBody,
			quantity: selectedBidQuantity()
		});
		return [response.job];
	}

	function pricingRequestBody():
		| {
				priceTierId: string;
				deltaEth: string;
		  }
		| {
				floorEth: string;
				ceilingEth: string;
				deltaEth: string;
				priceTierId: null;
		  } {
		return pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier
			? { priceTierId: selectedPriceTierId, deltaEth: displayedDeltaEth.trim() }
			: {
					floorEth: floorEth.trim(),
					ceilingEth: ceilingEth.trim(),
					deltaEth: deltaEth.trim(),
					priceTierId: null
				};
	}

	function selectedBidQuantity(): number | undefined {
		if (draft?.source.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid) {
			return undefined;
		}
		const parsed = Number(draft.source.bid.quantity);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
	}

	function hasSubmittableTarget(): boolean {
		if (!draft) {
			return !!targetTokenId;
		}
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch) {
			return draft.target.tokenIds.length > 0;
		}
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.FilteredTokenBatch) {
			return draft.source.type === BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens &&
				draft.source.state.kind === BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean &&
				canSubmitFilteredTokenBatch(draft);
		}
		if (draft.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob) {
			return draft.target.traits.length > 0;
		}
		return true;
	}

	function notifyJobsChanged(jobs: ApiBiddingJob[]): void {
		if (jobs.length === 1 && jobs[0].target.type === TRADING_JOB_TARGET_KIND.Token) {
			onJobChange?.(jobs[0]);
		}
		onJobsChange?.(jobs);
	}

	function resolveSaveMessage(count: number, wasExistingJob: boolean): string {
		if (count <= 1) {
			return wasExistingJob ? 'modified' : 'created';
		}
		return `${count} jobs saved`;
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
			const response = await archiveBiddingJob(fetch, chain.slug, collection.slug, currentJob.jobId);
			currentJob = null;
			if (response.job.target.type === TRADING_JOB_TARGET_KIND.Token) {
				onJobChange?.(null);
			}
			onJobsChange?.([response.job]);
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

{#if open && panelCollapsed}
	<button
		type="button"
		class="bidding-automation-panel-collapsed"
		class:bidding-automation-panel-collapsed-inline={variant === 'inline'}
		aria-label="show bidding panel"
		title="show bidding panel"
		onclick={showPanel}
	>
		<PlaceBidIcon className="bidding-automation-panel-collapsed-icon" />
	</button>
{:else if open}
	<div
		class="runtime-section bidding-automation-panel"
		class:bidding-automation-panel-inline={variant === 'inline'}
		role={variant === 'inline' ? 'region' : 'dialog'}
		aria-label="bidding automation"
	>
		<header class="panel-header bidding-automation-panel-header">
			<h2 class="panel-title">token bidding</h2>
			{#if variant !== 'inline'}
				<button type="button" class="button-link" onclick={hidePanel}>hide</button>
			{/if}
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
				<div>
					<span class="runtime-k">revision</span>
					<span class="runtime-v mono">{currentJob.revision}</span>
				</div>
				<div>
					<span class="runtime-k">modified</span>
					{#if modifiedAtMs === null}
						<span class="runtime-v mono">-</span>
					{:else}
						<button
							type="button"
							class="activities-time-mode-button token-bidding-time-value"
							aria-label="toggle modified time mode"
							title={jobTimeTitle(modifiedAtMs, modifiedAtMode)}
							onclick={toggleModifiedAtMode}
						>
							{formatJobTime(modifiedAtMs, modifiedAtMode)}
						</button>
					{/if}
				</div>
				<div>
					<span class="runtime-k">refreshed</span>
					{#if refreshedAtMs === null}
						<span class="runtime-v mono">-</span>
					{:else}
						<button
							type="button"
							class="activities-time-mode-button token-bidding-time-value"
							aria-label="toggle refreshed time mode"
							title={jobTimeTitle(refreshedAtMs, refreshedAtMode)}
							onclick={toggleRefreshedAtMode}
						>
							{formatJobTime(refreshedAtMs, refreshedAtMode)}
						</button>
					{/if}
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
			{/if}
		</div>
		{#if currentJob?.runtime?.lastError}
			<p class="runtime-error token-bidding-feedback" role="alert">{currentJob.runtime.lastError}</p>
		{/if}

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
	</div>
{/if}
