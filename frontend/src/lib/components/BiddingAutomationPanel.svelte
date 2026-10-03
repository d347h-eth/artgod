<script lang="ts">
	import { untrack } from 'svelte';
	import { isConfirmationActionTarget } from '$lib/action-confirmation';
	import type { TradingCompetitionPresetVersion } from '@artgod/shared/types';
	import type { BiddingCompetitionPresetInventory } from '$lib/bidding-competition-presets';
	import {
		competitionPresetMatchesTarget,
		competitionTraitsLabel
	} from '@artgod/shared/trading/trait-competition';
	import { DEFAULT_BIDDING_TRUST_OPENSEA_SIGNED_ZONE_TRAIT_OFFERS } from '@artgod/shared/config/bidding';
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
		applyBiddingSelectionJobAction,
		filterBiddingSelectionJobsForAction,
		hasSubmittableBiddingTarget,
		lookupBiddingAutomationDraftTargetJob,
		lookupBiddingSelectionJobs,
		resolveBiddingAutomationDraftTargetLookupKey,
		resolveBiddingSaveMessage,
		resolveBiddingSelectionJobsLookupKey,
		saveBiddingAutomationDraftJobs,
		type BiddingAutomationPricingRequest,
		type EditableBiddingJobStatus,
		type LookupBiddingSelectionJobsResult
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
	import {
		reconcileBiddingDeltaEth,
		resolveDefaultBiddingDeltaEth,
		validateBiddingDeltaInput
	} from '$lib/bidding-delta-input';
	import { biddingAuthorizationRecoveryMessage } from '$lib/bidding-authorization';
	import { ownBiddingJobStateBadges } from '$lib/bidding-bid-book-own-status';
	import {
		BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
		BIDDING_AUTOMATION_PRICING_MODE,
		BIDDING_AUTOMATION_PRICING_MODE_LABEL,
		BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
		biddingAutomationDraftTokenId,
		isBiddingAutomationBatchTokenDraft,
		isBiddingAutomationDraftSubmittable,
		type BiddingAutomationDraft,
		type BiddingAutomationPricingMode
	} from '$lib/bidding-automation';
	import {
		BIDDING_TRAIT_OFFER_TRUST_REQUIRED_MESSAGE,
		isBiddingAutomationTraitTarget
	} from '$lib/bidding-trait-offer-policy';
	import {
		BIDDING_SELECTION_ACTION_LABEL,
		BIDDING_SELECTION_JOB_ACTION,
		type BiddingSelectionJobAction
	} from '$lib/bidding-selection-actions';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import PlaceBidIcon from '$lib/components/PlaceBidIcon.svelte';
	import { TEST_IDS } from '$lib/test-ids';

	const BIDDING_PANEL_SELECTION_ACTION_PREFIX = 'selection-job';

	type PanelSelectionBiddingAction =
		`${typeof BIDDING_PANEL_SELECTION_ACTION_PREFIX}:${BiddingSelectionJobAction}`;
	type ConfirmableBiddingAction =
		| 'create'
		| 'modify'
		| 'activate'
		| 'pause'
		| 'archive'
		| PanelSelectionBiddingAction;

	let {
		open,
		chain,
		collection,
		token,
		job,
		draft = null,
		bidBook = null,
		jobsChangeSignal = 0,
		biddingSettings = defaultBiddingCollectionSettings(),
		priceTiers = [],
		competitionInventory = null,
		trustOpenSeaSignedZoneTraitOffers = DEFAULT_BIDDING_TRUST_OPENSEA_SIGNED_ZONE_TRAIT_OFFERS,
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
		jobsChangeSignal?: number;
		biddingSettings?: ApiBiddingCollectionSettings;
		priceTiers?: ApiBiddingPriceTier[];
		competitionInventory?: BiddingCompetitionPresetInventory | null;
		trustOpenSeaSignedZoneTraitOffers?: boolean;
		expandSignal?: number;
		showCollapsedLauncher?: boolean;
		onClose?: (() => void) | null;
		onJobChange?: ((job: ApiBiddingJob | null) => void) | null;
		onJobsChange?: ((jobs: ApiBiddingJob[]) => void) | null;
	} = $props();

	const initialPanelJob = resolveBiddingAutomationPanelJob({ job, draft, lookedUpJob: null });
	let currentJob = $state<ApiBiddingJob | null>(initialPanelJob);
	let selectedCompetitionVersionId = $state<string | null>(
		initialPanelJob?.config.competitionPreset?.versionId ?? null
	);
	let loadedJobKey = $state(
		resolveLoadedBiddingAutomationPanelKey({ job, draft, lookedUpJob: null })
	);
	let loadedDraftKey = $state(resolveBiddingAutomationPanelDraftIdentityKey(draft));
	let pricingMode = $state<BiddingAutomationPricingMode>(
		resolveInitialBiddingAutomationPricingMode({ job: initialPanelJob, draft })
	);
	let selectedPriceTierId = $state(
		resolveInitialBiddingAutomationPriceTierId({ job: initialPanelJob, draft })
	);
	let status = $state<EditableBiddingJobStatus>(
		resolveInitialBiddingAutomationStatus(initialPanelJob)
	);
	let floorEth = $state(resolveInitialBiddingAutomationFloorEth({ job: initialPanelJob, draft }));
	let ceilingEth = $state(resolveInitialBiddingAutomationCeilingEth({ job: initialPanelJob, draft }));
	let deltaEth = $state(
		resolveInitialBiddingAutomationDeltaEth({
			job: initialPanelJob,
			draft,
			defaultDeltaEth: biddingSettings.defaultDeltaEth
		})
	);
	let deltaInputTouched = $state(untrack(() => hasConfiguredDelta(initialPanelJob, draft)));
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
	let selectionLookupKey = $state('');
	let selectionLookupRequestKey = $state('');
	let selectionLookupResult = $state<LookupBiddingSelectionJobsResult | null>(null);
	let selectionLookupBusy = $state(false);
	let selectionJobActionBusy = $state<BiddingSelectionJobAction | null>(null);
	let draftInputTouched = $state(false);
	let competitionInputTouched = $state(false);

	const hasExistingJob = $derived(currentJob !== null);
	const targetTokenId = $derived(biddingAutomationDraftTokenId(draft) ?? token?.tokenId ?? null);
	const selectedTokenUnsupported = $derived(!draft && token?.marketplaceBiddingSupported === false);
	const selectedDraftUnsupported = $derived(
		selectedTokenUnsupported || !isBiddingAutomationDraftSubmittable(draft)
	);
	const selectedDraftUnsupportedMessage = $derived(resolveSelectedDraftUnsupportedMessage());
	const traitOfferTrustRequired = $derived(
		!trustOpenSeaSignedZoneTraitOffers && isBiddingAutomationTraitTarget({ draft, job: currentJob })
	);
	const bidStateBadges = $derived(ownBiddingJobStateBadges(currentJob, bidBook));
	const authorizationRecoveryMessage = $derived(
		currentJob?.status === TRADING_JOB_STATUS.Enabled && collection
			? biddingAuthorizationRecoveryMessage(bidBook?.biddingAuthorization ?? null, collection.slug)
			: null
	);
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
	const deltaValidation = $derived(
		validateBiddingDeltaInput({
			floorEth: displayedFloorEth,
			ceilingEth: displayedCeilingEth,
			deltaEth: displayedDeltaEth
		})
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
	const isOrdinaryTraitJob = $derived(
		draft?.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob ||
			(!draft &&
				currentJob?.target.type === TRADING_JOB_TARGET_KIND.Collection &&
				currentJob.target.targetTraits.length > 0)
	);
	const competitionPresets = $derived(competitionInventory?.presets ?? []);
	const competitionOptions = $derived.by(() => {
		const traits =
			draft?.target.type === BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob
				? draft.target.traits.map((t) => ({ type: t.key, value: t.value }))
				: currentJob?.target.type === TRADING_JOB_TARGET_KIND.Collection
					? currentJob.target.targetTraits
					: [];
		const options: TradingCompetitionPresetVersion[] = competitionPresets.filter((p) =>
			competitionPresetMatchesTarget(p, traits)
		);
		const saved = currentJob?.config.competitionPreset;
		if (saved && !options.some((p) => p.versionId === saved.versionId)) options.unshift(saved);
		return options;
	});
	const competitionChanged = $derived(
		isOrdinaryTraitJob &&
			competitionInputTouched &&
			selectedCompetitionVersionId !== (currentJob?.config.competitionPreset?.versionId ?? null)
	);
	const hasDraftChanges = $derived(
		competitionChanged ||
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
			!traitOfferTrustRequired &&
			hasSubmittableBiddingTarget({ draft, targetTokenId }) &&
			pricingAvailable &&
			priceInputsComplete &&
			deltaValidation.isValid
	);
	const isEnabledJob = $derived(currentJob?.status === TRADING_JOB_STATUS.Enabled);
	const isPausedJob = $derived(currentJob?.status === TRADING_JOB_STATUS.Paused);
	const isBatchTokenDraft = $derived(isBiddingAutomationBatchTokenDraft(draft));
	const panelMutationBusy = $derived(saving || archiving || selectionJobActionBusy !== null);
	const pricingInputsDisabled = $derived(
		panelMutationBusy || selectedDraftUnsupported || traitOfferTrustRequired
	);
	const canResetDraft = $derived(!traitOfferTrustRequired && !panelMutationBusy && hasDraftChanges);
	const canApplyBatchJobs = $derived(isBatchTokenDraft && !panelMutationBusy && canSubmitDraft);
	const canCreateJob = $derived(
		!hasExistingJob && !isBatchTokenDraft && !panelMutationBusy && canSubmitDraft
	);
	const canModifyJob = $derived(
		hasExistingJob && !panelMutationBusy && hasDraftChanges && canSubmitDraft
	);
	const canPauseJob = $derived(
		isEnabledJob &&
			!panelMutationBusy &&
			(traitOfferTrustRequired ? !!chain && !!collection && !!currentJob : canSubmitDraft)
	);
	const canActivateJob = $derived(isPausedJob && !panelMutationBusy && canSubmitDraft);
	const canArchiveJob = $derived(
		!!currentJob && (isEnabledJob || isPausedJob) && !panelMutationBusy && !!chain && !!collection
	);
	const showActivateSelectionJobs = $derived(
		hasSelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Activate)
	);
	const showPauseSelectionJobs = $derived(hasSelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Pause));
	const showArchiveSelectionJobs = $derived(
		hasSelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Archive)
	);
	const canActivateSelectionJobs = $derived(
		canApplySelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Activate)
	);
	const canPauseSelectionJobs = $derived(
		canApplySelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Pause)
	);
	const canArchiveSelectionJobs = $derived(
		canApplySelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Archive)
	);
	const showSelectionJobActions = $derived(
		showActivateSelectionJobs || showPauseSelectionJobs || showArchiveSelectionJobs
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
				archiving: archiving || selectionJobActionBusy !== null
			})
		) {
			currentJob = nextJob;
			// A pricing edit does not prevent the lookup from hydrating untouched extras.
			if (!competitionInputTouched) {
				selectedCompetitionVersionId = nextJob?.config.competitionPreset?.versionId ?? null;
			}
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
		void refreshSelectionLookupJobs();
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
		if (!armedAction || isConfirmationActionTarget(target, armedAction, 'data-bidding-action')) {
			return;
		}
		armedAction = null;
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
			bidBook,
			jobsChangeSignal
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
			if (targetLookupKey === nextLookupKey && targetLookupRequestKey === nextLookupRequestKey) {
				targetLookupJob = lookedUpJob;
			}
		} catch (error) {
			if (targetLookupKey === nextLookupKey && targetLookupRequestKey === nextLookupRequestKey) {
				saveError = error instanceof Error ? error.message : 'failed to look up bidding job';
			}
		}
	}

	async function refreshSelectionLookupJobs(): Promise<void> {
		const nextLookupKey = resolveBiddingSelectionJobsLookupKey({
			chain,
			collection,
			draft
		});
		const nextLookupRequestKey = resolveBiddingAutomationPanelTargetLookupRequestKey({
			targetLookupKey: nextLookupKey,
			bidBook,
			jobsChangeSignal
		});
		if (nextLookupRequestKey === selectionLookupRequestKey) {
			return;
		}
		if (nextLookupKey !== selectionLookupKey) {
			selectionLookupResult = null;
		}
		selectionLookupKey = nextLookupKey;
		selectionLookupRequestKey = nextLookupRequestKey;
		if (!nextLookupKey || !chain || !collection) {
			selectionLookupBusy = false;
			return;
		}

		selectionLookupBusy = true;
		try {
			// Resolve exact selected targets to declared jobs before rendering mass actions.
			const result = await lookupBiddingSelectionJobs({
				fetchFn: fetch,
				chainRef: chain.slug,
				collectionRef: collection.slug,
				draft
			});
			if (
				selectionLookupKey === nextLookupKey &&
				selectionLookupRequestKey === nextLookupRequestKey
			) {
				selectionLookupResult = result;
			}
		} catch {
			if (
				selectionLookupKey === nextLookupKey &&
				selectionLookupRequestKey === nextLookupRequestKey
			) {
				selectionLookupResult = null;
			}
		} finally {
			if (
				selectionLookupKey === nextLookupKey &&
				selectionLookupRequestKey === nextLookupRequestKey
			) {
				selectionLookupBusy = false;
			}
		}
	}

	function applyDraft(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): void {
		selectedCompetitionVersionId = value?.config.competitionPreset?.versionId ?? null;
		competitionInputTouched = false;
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
		deltaInputTouched = hasConfiguredDelta(value, currentDraft);
	}

	function hasConfiguredDelta(
		value: ApiBiddingJob | null,
		currentDraft: BiddingAutomationDraft | null
	): boolean {
		return (
			!!value ||
			(!!currentDraft &&
				currentDraft.source.type !== BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid &&
				!!currentDraft.pricing.deltaEth)
		);
	}

	function onPriceRangeInput(event: Event, endpoint: 'floor' | 'ceiling'): void {
		if (!(event.currentTarget instanceof HTMLInputElement)) {
			return;
		}
		markDraftInputTouched();
		if (endpoint === 'floor') {
			floorEth = event.currentTarget.value;
		} else {
			ceilingEth = event.currentTarget.value;
		}
		deltaEth = deltaInputTouched
			? reconcileBiddingDeltaEth({ floorEth, ceilingEth, deltaEth })
			: resolveDefaultBiddingDeltaEth({
					floorEth,
					ceilingEth,
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
			deltaEth = reconcileBiddingDeltaEth({
				floorEth,
				ceilingEth,
				deltaEth: displayedDeltaEth
			});
			deltaInputTouched = true;
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

	function selectCompetitionPreset(versionId: string | null): void {
		selectedCompetitionVersionId = versionId;
		competitionInputTouched = true;
		markDraftInputTouched();
		armedAction = null;
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
		if (selectedTokenUnsupported) {
			return 'selected token target is not available for marketplace bidding';
		}
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
		const allowedReadOnlyPause =
			traitOfferTrustRequired && statusOverride === TRADING_JOB_STATUS.Paused && canPauseJob;
		if (
			!chain ||
			!collection ||
			selectedDraftUnsupported ||
			panelMutationBusy ||
			(!canSubmitDraft && !allowedReadOnlyPause)
		) {
			return;
		}
		if (statusOverride === null && hasExistingJob && !canModifyJob) {
			return;
		}
		if (statusOverride === null && isBatchTokenDraft && !canApplyBatchJobs) {
			return;
		}
		if (statusOverride === null && !hasExistingJob && !isBatchTokenDraft && !canCreateJob) {
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
				// Omission preserves the saved version for price and lifecycle-only updates.
				competitionPresetVersionId:
					competitionChanged && !allowedReadOnlyPause ? selectedCompetitionVersionId : undefined,
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
						: resolveBiddingSaveMessage(changedJobs.length, wasExistingJob, isBatchTokenDraft);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to save bidding job';
		} finally {
			saving = false;
		}
	}

	function pricingRequestBody(): BiddingAutomationPricingRequest {
		return pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier
			? {
					priceTierId: selectedPriceTierId,
					deltaEth: deltaValidation.normalizedDeltaEth ?? displayedDeltaEth.trim()
				}
			: {
					floorEth: floorEth.trim(),
					ceilingEth: ceilingEth.trim(),
					deltaEth: deltaValidation.normalizedDeltaEth ?? deltaEth.trim(),
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
		if (!canArchiveJob || !chain || !collection || !currentJob || panelMutationBusy) {
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

	function canApplySelectionJobAction(action: BiddingSelectionJobAction): boolean {
		if (panelMutationBusy || selectionLookupBusy || !chain || !collection) {
			return false;
		}
		return hasSelectionJobAction(action);
	}

	function hasSelectionJobAction(action: BiddingSelectionJobAction): boolean {
		if (!selectionLookupResult || selectionLookupResult.targetCount <= 1) {
			return false;
		}
		return filterBiddingSelectionJobsForAction(selectionLookupResult.jobs, action).length > 0;
	}

	function selectionConfirmableAction(
		action: BiddingSelectionJobAction
	): PanelSelectionBiddingAction {
		return `${BIDDING_PANEL_SELECTION_ACTION_PREFIX}:${action}`;
	}

	async function handleSelectionJobAction(action: BiddingSelectionJobAction): Promise<void> {
		if (!canApplySelectionJobAction(action) || !chain || !collection) {
			return;
		}

		selectionJobActionBusy = action;
		armedAction = null;
		saveMessage = null;
		saveError = null;

		try {
			// Apply the mass action through the same pricing-preserving job mutation path.
			const result = await applyBiddingSelectionJobAction({
				fetchFn: fetch,
				chainRef: chain.slug,
				collectionRef: collection.slug,
				draft,
				action
			});
			const jobs = mergeSelectionLookupJobs(selectionLookupResult?.jobs ?? [], result.jobs);
			selectionLookupResult = {
				jobs,
				targetCount: result.targetCount,
				existingTargetCount: jobs.length,
				missingTargetCount: Math.max(0, result.targetCount - jobs.length)
			};
			notifyJobsChanged(result.jobs);
			saveMessage = selectionJobActionResultMessage(action, result.jobs.length);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to update selected bidding jobs';
		} finally {
			selectionJobActionBusy = null;
		}
	}

	function selectionJobActionResultMessage(
		action: BiddingSelectionJobAction,
		changedCount: number
	): string {
		const subject = changedCount === 1 ? '1 job' : `${changedCount} jobs`;
		if (action === BIDDING_SELECTION_JOB_ACTION.Activate) {
			return `activated ${subject}`;
		}
		if (action === BIDDING_SELECTION_JOB_ACTION.Pause) {
			return `paused ${subject}`;
		}
		return `archived ${subject}`;
	}

	function mergeSelectionLookupJobs(
		previousJobs: ApiBiddingJob[],
		changedJobs: ApiBiddingJob[]
	): ApiBiddingJob[] {
		const jobsById = new Map(previousJobs.map((job) => [job.jobId, job]));
		for (const job of changedJobs) {
			jobsById.set(job.jobId, job);
		}
		return Array.from(jobsById.values());
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
		{#if authorizationRecoveryMessage}
			<p class="runtime-warn token-bidding-feedback" role="alert">
				{authorizationRecoveryMessage}
			</p>
		{:else if currentJob?.runtime?.lastError}
			<p class="runtime-error token-bidding-feedback" role="alert">{currentJob.runtime.lastError}</p>
		{/if}
		{#if traitOfferTrustRequired}
			<p class="runtime-warn token-bidding-feedback" role="alert">
				{BIDDING_TRAIT_OFFER_TRUST_REQUIRED_MESSAGE}
			</p>
		{/if}

		{#if selectedDraftUnsupported}
			<p class="runtime-error token-bidding-feedback" role="alert">
				{selectedDraftUnsupportedMessage}
			</p>
		{:else if !traitOfferTrustRequired || hasExistingJob}
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
						disabled={pricingInputsDisabled}
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
							disabled={pricingInputsDisabled}
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
								disabled={pricingInputsDisabled}
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
						value={floorEth}
						oninput={(event) => onPriceRangeInput(event, 'floor')}
						disabled={pricingInputsDisabled}
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
						value={ceilingEth}
						oninput={(event) => onPriceRangeInput(event, 'ceiling')}
						disabled={pricingInputsDisabled}
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
					aria-invalid={!deltaValidation.isValid}
					aria-describedby={deltaValidation.warning
						? TEST_IDS.BiddingPanelDeltaWarning
						: undefined}
					oninput={(event) => {
						if (
							pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Manual &&
							event.currentTarget instanceof HTMLInputElement
						) {
							markDraftInputTouched();
							deltaInputTouched = true;
							deltaEth = event.currentTarget.value;
						}
					}}
					disabled={pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier ||
						pricingInputsDisabled}
				/>
				{#if deltaValidation.warning}
					<span
						id={TEST_IDS.BiddingPanelDeltaWarning}
						data-testid={TEST_IDS.BiddingPanelDeltaWarning}
						class="runtime-warn bidding-delta-feedback"
						role="status"
					>
						{deltaValidation.warning}
						{#if pricingMode === BIDDING_AUTOMATION_PRICING_MODE.Tier}
							Edit the price tier's delta or select manual pricing.
						{/if}
					</span>
				{/if}
			</div>
			{#if isOrdinaryTraitJob}
				<div class="bootstrap-form-row token-bidding-competition-row">
					<label for="bidding-extra-targets-select"><span>extra targets</span></label>
					<div
						id="bidding-extra-targets-select"
						class="secondary-tabs token-bidding-competition-options"
						role="group"
						aria-label="Extra targets"
					>
						<button
							type="button"
							class:secondary-tab-active={selectedCompetitionVersionId === null}
							aria-pressed={selectedCompetitionVersionId === null}
							disabled={pricingInputsDisabled || selectedCompetitionVersionId === null}
							onclick={() => selectCompetitionPreset(null)}
						>
							none
						</button>
						{#each competitionOptions as preset (preset.versionId)}
							<button
								type="button"
								title={competitionTraitsLabel(preset.extraCompetitionTraits)}
								class:secondary-tab-active={selectedCompetitionVersionId === preset.versionId}
								aria-pressed={selectedCompetitionVersionId === preset.versionId}
								disabled={pricingInputsDisabled || selectedCompetitionVersionId === preset.versionId}
								onclick={() => selectCompetitionPreset(preset.versionId)}
							>
								{competitionTraitsLabel(preset.extraCompetitionTraits) + (!competitionPresets.some((p) => p.versionId === preset.versionId) ? ` (v${preset.revision})` : '')}
							</button>
						{/each}
						{#if competitionInventory?.error && !competitionInventory.loading}
							<button
								type="button"
								class="action-button-neutral"
								onclick={() => void competitionInventory?.refresh()}
								disabled={panelMutationBusy}
							>
								refresh
							</button>
						{/if}
					</div>
				</div>
				{#if competitionInventory?.loading || competitionInventory?.error}
					<div class="bootstrap-form-row">
						<span aria-hidden="true"></span>
						{#if competitionInventory.loading}
							<p class="muted token-bidding-feedback" role="status">loading...</p>
						{:else}
							<p class="runtime-error token-bidding-feedback" role="alert">
								{competitionInventory.error}
							</p>
						{/if}
					</div>
				{/if}
			{/if}
			<div class="panel-footer token-bidding-form-footer">
				<div class="token-bidding-form-actions-left">
					{#if !traitOfferTrustRequired}
						<button type="button" onclick={resetDraft} disabled={!canResetDraft}>reset</button>
					{/if}
					{#if !isBatchTokenDraft && (!hasExistingJob || isEnabledJob)}
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
					{#if !isBatchTokenDraft}
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
					{/if}
				</div>
				<div class="token-bidding-form-actions-right">
					{#if hasExistingJob && !traitOfferTrustRequired}
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
					{:else if isBatchTokenDraft && !traitOfferTrustRequired}
						<button
							type="button"
							class="token-bidding-action-positive"
							class:token-bidding-action-armed={armedAction === 'create'}
							data-bidding-action="create"
							data-testid={TEST_IDS.BiddingPanelCreate}
							onclick={() => void confirmBiddingAction('create', () => handleSave())}
							disabled={!canApplyBatchJobs}
						>
							{saving ? 'saving...' : BIDDING_SELECTION_ACTION_LABEL.ApplyBiddingSpec}
						</button>
					{:else if !traitOfferTrustRequired}
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
				{#if showSelectionJobActions && !traitOfferTrustRequired}
					<div class="token-bidding-selection-actions" aria-label="selected bidding target actions">
						{#if showActivateSelectionJobs}
							<button
								type="button"
								class="token-bidding-action-positive"
								class:token-bidding-action-armed={armedAction ===
									selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Activate)}
								data-bidding-action={selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Activate)}
								data-testid={TEST_IDS.BiddingPanelSelectionActivate}
								onclick={() =>
									void confirmBiddingAction(
										selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Activate),
										() => handleSelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Activate)
									)}
								disabled={!canActivateSelectionJobs}
							>
								{BIDDING_SELECTION_ACTION_LABEL.ActivateSelected}
							</button>
						{/if}
						{#if showPauseSelectionJobs}
							<button
								type="button"
								class="token-bidding-action-negative"
								class:token-bidding-action-armed={armedAction ===
									selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Pause)}
								data-bidding-action={selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Pause)}
								data-testid={TEST_IDS.BiddingPanelSelectionPause}
								onclick={() =>
									void confirmBiddingAction(
										selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Pause),
										() => handleSelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Pause)
									)}
								disabled={!canPauseSelectionJobs}
							>
								{BIDDING_SELECTION_ACTION_LABEL.PauseSelected}
							</button>
						{/if}
						{#if showArchiveSelectionJobs}
							<button
								type="button"
								class="token-bidding-action-negative"
								class:token-bidding-action-armed={armedAction ===
									selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Archive)}
								data-bidding-action={selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Archive)}
								data-testid={TEST_IDS.BiddingPanelSelectionArchive}
								onclick={() =>
									void confirmBiddingAction(
										selectionConfirmableAction(BIDDING_SELECTION_JOB_ACTION.Archive),
										() => handleSelectionJobAction(BIDDING_SELECTION_JOB_ACTION.Archive)
									)}
								disabled={!canArchiveSelectionJobs}
							>
								{BIDDING_SELECTION_ACTION_LABEL.ArchiveSelected}
							</button>
						{/if}
					</div>
				{/if}
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
