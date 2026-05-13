<script lang="ts">
	import {
		TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
		TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
		TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
		TRADING_BIDDING_TIER_SELECTION_MODE,
		TRADING_JOB_STATUS
	} from '@artgod/shared/types';
	import type {
		ApiBiddingJob,
		ApiBiddingCollectionSettings,
		ApiBiddingPriceTier,
		ApiBiddingPriceTierCeilingConfig,
		ApiBiddingPriceTierFloorConfig,
		ApiBiddingPriceTierReapplyJobPreview,
		ApiChain,
		ApiCollection
	} from '$lib/api-types';
	import {
		applyBiddingPriceTierReapply,
		archiveCollectionBiddingPriceTier,
		previewBiddingPriceTierReapply,
		updateCollectionBiddingSettings,
		upsertCollectionBiddingPriceTier
	} from '$lib/backend-api';
	import BiddingPriceTierReapplyPreview from '$lib/components/BiddingPriceTierReapplyPreview.svelte';
	import BiddingPriceTierRow from '$lib/components/BiddingPriceTierRow.svelte';

	type EditablePriceTierStatus =
		| typeof TRADING_JOB_STATUS.Enabled
		| typeof TRADING_JOB_STATUS.Paused;
	type PriceTierAction = 'create' | 'modify' | 'pause' | 'activate' | 'archive' | 'reapply';
	type DeltaKind =
		(typeof TRADING_BIDDING_PRICE_TIER_DELTA_KIND)[keyof typeof TRADING_BIDDING_PRICE_TIER_DELTA_KIND];

	let {
		chain,
		collection,
		settings,
		tiers,
		onSettingsChange,
		onTiersChange,
		onJobsChange = null,
		onClose = null
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		settings: ApiBiddingCollectionSettings;
		tiers: ApiBiddingPriceTier[];
		onSettingsChange: (settings: ApiBiddingCollectionSettings) => void;
		onTiersChange: (tiers: ApiBiddingPriceTier[]) => void;
		onJobsChange?: ((jobs: ApiBiddingJob[]) => void) | null;
		onClose?: (() => void) | null;
	} = $props();

	let editingTierId = $state<string | null>(null);
	let name = $state('');
	let formStatus = $state<EditablePriceTierStatus>(TRADING_JOB_STATUS.Enabled);
	let sortOrderText = $state(String(nextSortOrder(tiers)));
	let parentTierId = $state('');
	let floorKind = $state<ApiBiddingPriceTierFloorConfig['kind']>(
		TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed
	);
	let floorValueEth = $state('');
	let floorDeltaKind = $state<DeltaKind>(TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute);
	let floorDeltaEth = $state('');
	let floorPercent = $state('');
	let ceilingKind = $state<ApiBiddingPriceTierCeilingConfig['kind']>(
		TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed
	);
	let ceilingValueEth = $state('');
	let ceilingDeltaKind = $state<DeltaKind>(TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute);
	let ceilingDeltaEth = $state('');
	let ceilingPercent = $state('');
	let tierDeltaEth = $state(settings.defaultDeltaEth);
	let tierSelectionMode = $state<ApiBiddingCollectionSettings['tierSelectionMode']>(
		settings.tierSelectionMode
	);
	let defaultDeltaEth = $state(settings.defaultDeltaEth);
	let settingsSaving = $state(false);
	let saving = $state(false);
	let busyActionKey = $state<string | null>(null);
	let saveMessage = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let armedActionKey = $state<string | null>(null);
	let nowMs = $state(Date.now());
	let reapplyTierId = $state<string | null>(null);
	let reapplyTierName = $state<string | null>(null);
	let reapplyJobs = $state<ApiBiddingPriceTierReapplyJobPreview[]>([]);
	let selectedReapplyJobIds = $state<string[]>([]);
	let reapplyLoading = $state(false);
	let reapplyApplying = $state(false);

	const sortedTiers = $derived(sortTiers(tiers));
	const activeTiers = $derived(
		sortedTiers.filter((tier) => tier.status !== TRADING_JOB_STATUS.Archived)
	);
	const editingTier = $derived(
		editingTierId ? (tiers.find((tier) => tier.tierId === editingTierId) ?? null) : null
	);
	const hasParent = $derived(parentTierId.trim().length > 0);
	const busy = $derived(saving || busyActionKey !== null || reapplyLoading || reapplyApplying);
	const settingsChanged = $derived(
		tierSelectionMode !== settings.tierSelectionMode ||
			defaultDeltaEth.trim() !== settings.defaultDeltaEth
	);
	const canSaveSettings = $derived(
		!!chain && !!collection && !settingsSaving && settingsChanged && defaultDeltaEth.trim().length > 0
	);
	const canSubmit = $derived(resolveCanSubmit());
	const canCreate = $derived(!editingTier && canSubmit);
	const canModify = $derived(!!editingTier && canSubmit);

	$effect(() => {
		const timer = window.setInterval(() => {
			nowMs = Date.now();
		}, 60_000);
		return () => window.clearInterval(timer);
	});

	$effect(() => {
		tierSelectionMode = settings.tierSelectionMode;
		defaultDeltaEth = settings.defaultDeltaEth;
		if (!editingTierId) {
			tierDeltaEth = settings.defaultDeltaEth;
		}
	});

	$effect(() => {
		if (!hasParent && floorKind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta) {
			floorKind = TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed;
		}
		if (
			!hasParent &&
			ceilingKind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta
		) {
			ceilingKind = TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta;
		}
	});

	function sortTiers(value: ApiBiddingPriceTier[]): ApiBiddingPriceTier[] {
		return [...value].sort((left, right) => {
			const orderCompare = left.sortOrder - right.sortOrder;
			return orderCompare === 0 ? left.name.localeCompare(right.name) : orderCompare;
		});
	}

	function nextSortOrder(value: ApiBiddingPriceTier[]): number {
		const active = value.filter((tier) => tier.status !== TRADING_JOB_STATUS.Archived);
		return active.length === 0 ? 10 : Math.max(...active.map((tier) => tier.sortOrder)) + 10;
	}

	function parentName(tier: ApiBiddingPriceTier): string | null {
		return tier.parentTierId
			? (tiers.find((candidate) => candidate.tierId === tier.parentTierId)?.name ?? tier.parentTierId)
			: null;
	}

	function resetForm(nextTiers = tiers): void {
		editingTierId = null;
		name = '';
		formStatus = TRADING_JOB_STATUS.Enabled;
		sortOrderText = String(nextSortOrder(nextTiers));
		parentTierId = '';
		floorKind = TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed;
		floorValueEth = '';
		floorDeltaKind = TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute;
		floorDeltaEth = '';
		floorPercent = '';
		ceilingKind = TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed;
		ceilingValueEth = '';
		ceilingDeltaKind = TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute;
		ceilingDeltaEth = '';
		ceilingPercent = '';
		tierDeltaEth = settings.defaultDeltaEth;
		saveMessage = null;
		saveError = null;
		armedActionKey = null;
	}

	function editTier(tier: ApiBiddingPriceTier): void {
		editingTierId = tier.tierId;
		name = tier.name;
		formStatus =
			tier.status === TRADING_JOB_STATUS.Paused
				? TRADING_JOB_STATUS.Paused
				: TRADING_JOB_STATUS.Enabled;
		sortOrderText = String(tier.sortOrder);
		parentTierId = tier.parentTierId ?? '';
		applyFloorConfig(tier.floorConfig);
		applyCeilingConfig(tier.ceilingConfig);
		tierDeltaEth = tier.deltaEth;
		saveMessage = null;
		saveError = null;
		armedActionKey = null;
	}

	function applyFloorConfig(config: ApiBiddingPriceTierFloorConfig): void {
		floorKind = config.kind;
		if (config.kind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed) {
			floorValueEth = config.valueEth;
			return;
		}
		floorDeltaKind = config.deltaKind;
		floorDeltaEth = config.deltaEth ?? '';
		floorPercent = config.percent ?? '';
	}

	function applyCeilingConfig(config: ApiBiddingPriceTierCeilingConfig): void {
		ceilingKind = config.kind;
		if (config.kind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed) {
			ceilingValueEth = config.valueEth;
			return;
		}
		ceilingDeltaKind = config.deltaKind;
		ceilingDeltaEth = config.deltaEth ?? '';
		ceilingPercent = config.percent ?? '';
	}

	function resolveCanSubmit(): boolean {
		return (
			!!chain &&
			!!collection &&
			!busy &&
			name.trim().length > 0 &&
			Number.isInteger(Number(sortOrderText.trim())) &&
			isFloorConfigComplete() &&
			isCeilingConfigComplete() &&
			tierDeltaEth.trim().length > 0
		);
	}

	function isFloorConfigComplete(): boolean {
		if (!hasParent || floorKind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed) {
			return floorValueEth.trim().length > 0;
		}
		return isDeltaComplete(floorDeltaKind, floorDeltaEth, floorPercent);
	}

	function isCeilingConfigComplete(): boolean {
		if (ceilingKind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed) {
			return ceilingValueEth.trim().length > 0;
		}
		if (
			ceilingKind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta &&
			!hasParent
		) {
			return false;
		}
		return isDeltaComplete(ceilingDeltaKind, ceilingDeltaEth, ceilingPercent);
	}

	function isDeltaComplete(kind: DeltaKind, deltaEth: string, percent: string): boolean {
		return kind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute
			? deltaEth.trim().length > 0
			: percent.trim().length > 0;
	}

	function buildFloorConfig(): ApiBiddingPriceTierFloorConfig {
		if (!hasParent || floorKind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed) {
			return {
				kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
				valueEth: floorValueEth.trim()
			};
		}
		return {
			kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
			...buildDeltaConfig(floorDeltaKind, floorDeltaEth, floorPercent)
		};
	}

	function buildCeilingConfig(): ApiBiddingPriceTierCeilingConfig {
		if (ceilingKind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed) {
			return {
				kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
				valueEth: ceilingValueEth.trim()
			};
		}
		const kind =
			ceilingKind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta && hasParent
				? TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta
				: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta;
		return {
			kind,
			...buildDeltaConfig(ceilingDeltaKind, ceilingDeltaEth, ceilingPercent)
		};
	}

	function buildDeltaConfig(kind: DeltaKind, deltaEth: string, percent: string) {
		return kind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute
			? { deltaKind: kind, deltaEth: deltaEth.trim() }
			: { deltaKind: kind, percent: percent.trim() };
	}

	async function handleSave(): Promise<void> {
		if (!canSubmit || !chain || !collection) {
			return;
		}

		saving = true;
		saveMessage = null;
		saveError = null;
		armedActionKey = null;

		try {
			// Persist the typed tier config through the backend graph-validation use case.
			const response = await upsertCollectionBiddingPriceTier(fetch, chain.slug, collection.slug, {
				tierId: editingTierId ?? undefined,
				name: name.trim(),
				status: formStatus,
				sortOrder: Number(sortOrderText.trim()),
				parentTierId: parentTierId.trim() || null,
				floorConfig: buildFloorConfig(),
				ceilingConfig: buildCeilingConfig(),
				deltaEth: tierDeltaEth.trim()
			});
			onTiersChange(response.tiers);
			if (editingTierId) {
				editTier(response.tier);
				saveMessage = 'modified';
			} else {
				resetForm(response.tiers);
				saveMessage = 'created';
			}
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to save price tier';
		} finally {
			saving = false;
		}
	}

	async function handleConfirmedSave(action: PriceTierAction): Promise<void> {
		await confirmAction(`${action}:form`, handleSave);
	}

	async function handleMove(tier: ApiBiddingPriceTier, direction: -1 | 1): Promise<void> {
		if (!chain || !collection || busy) {
			return;
		}
		const index = activeTiers.findIndex((candidate) => candidate.tierId === tier.tierId);
		const neighbor = activeTiers[index + direction];
		if (!neighbor) {
			return;
		}

		busyActionKey = `move:${tier.tierId}:${direction}`;
		saveMessage = null;
		saveError = null;
		armedActionKey = null;

		try {
			// Reorder by moving this tier just outside its adjacent neighbor's sort order.
			const response = await upsertCollectionBiddingPriceTier(fetch, chain.slug, collection.slug, {
				tierId: tier.tierId,
				name: tier.name,
				status: tier.status === TRADING_JOB_STATUS.Paused ? TRADING_JOB_STATUS.Paused : TRADING_JOB_STATUS.Enabled,
				sortOrder: neighbor.sortOrder + direction,
				parentTierId: tier.parentTierId,
				floorConfig: tier.floorConfig,
				ceilingConfig: tier.ceilingConfig,
				deltaEth: tier.deltaEth
			});
			onTiersChange(response.tiers);
			if (editingTierId === response.tier.tierId) {
				editTier(response.tier);
			}
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to reorder price tier';
		} finally {
			busyActionKey = null;
		}
	}

	async function handlePreviewReapply(tier: ApiBiddingPriceTier): Promise<void> {
		if (!chain || !collection || busy) {
			return;
		}
		reapplyLoading = true;
		saveMessage = null;
		saveError = null;
		armedActionKey = null;
		try {
			// Ask the backend to calculate the staged job diffs from current tier resolution.
			const response = await previewBiddingPriceTierReapply(
				fetch,
				chain.slug,
				collection.slug,
				tier.tierId
			);
			reapplyTierId = response.tier.tierId;
			reapplyTierName = response.tier.name;
			reapplyJobs = response.jobs;
			selectedReapplyJobIds = response.jobs
				.filter((job) => job.changed)
				.map((job) => job.job.jobId);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to preview tier reapply';
		} finally {
			reapplyLoading = false;
		}
	}

	function toggleReapplyJob(jobId: string): void {
		const selected = new Set(selectedReapplyJobIds);
		if (selected.has(jobId)) {
			selected.delete(jobId);
		} else {
			selected.add(jobId);
		}
		selectedReapplyJobIds = [...selected];
	}

	async function handleApplyReapply(): Promise<void> {
		await confirmAction('reapply:form', async () => {
			if (!chain || !collection || !reapplyTierId || selectedReapplyJobIds.length === 0) {
				return;
			}
			reapplyApplying = true;
			saveMessage = null;
			saveError = null;
			try {
				// Apply selected staged diffs through the backend job mutation path.
				const response = await applyBiddingPriceTierReapply(
					fetch,
					chain.slug,
					collection.slug,
					reapplyTierId,
					{ jobIds: selectedReapplyJobIds }
				);
				onJobsChange?.(response.jobs);
				reapplyApplying = false;
				await handlePreviewReapply(response.tier);
				saveMessage = 'reapplied';
			} catch (error) {
				saveError = error instanceof Error ? error.message : 'failed to apply tier reapply';
			} finally {
				reapplyApplying = false;
			}
		});
	}

	async function handleStatusChange(
		tier: ApiBiddingPriceTier,
		status: EditablePriceTierStatus
	): Promise<void> {
		const action = status === TRADING_JOB_STATUS.Enabled ? 'activate' : 'pause';
		await confirmAction(`${action}:${tier.tierId}`, async () => {
			if (!chain || !collection || busy) {
				return;
			}
			busyActionKey = `${action}:${tier.tierId}`;
			saveMessage = null;
			saveError = null;
			try {
				// Update lifecycle intent without changing the tier's pricing config.
				const response = await upsertCollectionBiddingPriceTier(fetch, chain.slug, collection.slug, {
					tierId: tier.tierId,
					name: tier.name,
					status,
					sortOrder: tier.sortOrder,
					parentTierId: tier.parentTierId,
					floorConfig: tier.floorConfig,
					ceilingConfig: tier.ceilingConfig,
					deltaEth: tier.deltaEth
				});
				onTiersChange(response.tiers);
				if (editingTierId === response.tier.tierId) {
					editTier(response.tier);
				}
				saveMessage = status === TRADING_JOB_STATUS.Enabled ? 'activated' : 'paused';
			} catch (error) {
				saveError = error instanceof Error ? error.message : 'failed to update price tier';
			} finally {
				busyActionKey = null;
			}
		});
	}

	async function handleArchive(tier: ApiBiddingPriceTier): Promise<void> {
		await confirmAction(`archive:${tier.tierId}`, async () => {
			if (!chain || !collection || busy) {
				return;
			}
			busyActionKey = `archive:${tier.tierId}`;
			saveMessage = null;
			saveError = null;
			try {
				// Archive the tier definition without cascading into tier-backed jobs.
				const response = await archiveCollectionBiddingPriceTier(
					fetch,
					chain.slug,
					collection.slug,
					tier.tierId
				);
				onTiersChange(response.tiers);
				if (editingTierId === tier.tierId) {
					resetForm(response.tiers);
				}
				saveMessage = 'archived';
			} catch (error) {
				saveError = error instanceof Error ? error.message : 'failed to archive price tier';
			} finally {
				busyActionKey = null;
			}
		});
	}

	async function handleSaveSettings(): Promise<void> {
		if (!canSaveSettings || !chain || !collection) {
			return;
		}
		settingsSaving = true;
		saveMessage = null;
		saveError = null;
		try {
			// Persist collection-scoped bidding UI defaults through the settings use case.
			const response = await updateCollectionBiddingSettings(fetch, chain.slug, collection.slug, {
				tierSelectionMode,
				defaultDeltaEth: defaultDeltaEth.trim()
			});
			onSettingsChange(response.settings);
			if (!editingTierId) {
				tierDeltaEth = response.settings.defaultDeltaEth;
			}
			saveMessage = 'settings saved';
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'failed to save bidding settings';
		} finally {
			settingsSaving = false;
		}
	}

	async function confirmAction(actionKey: string, action: () => Promise<void>): Promise<void> {
		if (armedActionKey !== actionKey) {
			armedActionKey = actionKey;
			return;
		}
		armedActionKey = null;
		await action();
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (eventHitsArmedAction(event.target)) {
			return;
		}
		armedActionKey = null;
	}

	function onWindowFocusIn(event: FocusEvent): void {
		if (eventHitsArmedAction(event.target)) {
			return;
		}
		armedActionKey = null;
	}

	function eventHitsArmedAction(target: EventTarget | null): boolean {
		if (!armedActionKey || !(target instanceof Element)) {
			return false;
		}
		let element: Element | null = target;
		while (element) {
			if (
				element instanceof HTMLElement &&
				element.dataset.priceTierAction === armedActionKey
			) {
				return true;
			}
			element = element.parentElement;
		}
		return false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onfocusin={onWindowFocusIn} />

<section class="runtime-section bidding-price-tier-panel" aria-label="price tiers">
	<header class="panel-header bidding-price-tier-header">
		<h2 class="panel-title">price tiers</h2>
		{#if onClose}
			<button type="button" class="button-link" onclick={onClose}>hide</button>
		{/if}
	</header>

	<div class="runtime-kv-grid bid-book-meta bidding-price-tier-meta">
		<div>
			<span class="runtime-k">tiers</span>
			<span class="runtime-v">{activeTiers.length}</span>
		</div>
		<div>
			<span class="runtime-k">editing</span>
			<span class="runtime-v mono">{editingTier?.name ?? 'new'}</span>
		</div>
	</div>

	<form
		class="bootstrap-form bidding-price-tier-settings-form"
		onsubmit={(event) => {
			event.preventDefault();
			void handleSaveSettings();
		}}
	>
		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-selector-mode"><span>tier selector</span></label>
			<label class="bidding-price-tier-checkbox-label" for="bidding-price-tier-selector-mode">
				<input
					id="bidding-price-tier-selector-mode"
					type="checkbox"
					checked={tierSelectionMode === TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown}
					disabled={settingsSaving}
					onchange={(event) => {
						tierSelectionMode =
							event.currentTarget instanceof HTMLInputElement && event.currentTarget.checked
								? TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown
								: TRADING_BIDDING_TIER_SELECTION_MODE.Buttons;
					}}
				/>
				dropdown
			</label>
		</div>
		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-default-delta"><span>default delta ETH</span></label>
			<input
				id="bidding-price-tier-default-delta"
				class="bootstrap-control bidding-price-tier-price-input"
				type="text"
				inputmode="decimal"
				bind:value={defaultDeltaEth}
				disabled={settingsSaving}
			/>
		</div>
		<div class="bidding-price-tier-settings-actions">
			<button type="submit" class="token-bidding-action-positive" disabled={!canSaveSettings}>
				{settingsSaving ? 'saving...' : 'save settings'}
			</button>
		</div>
	</form>

	{#if activeTiers.length > 0}
		<div class="table-wrap bidding-price-tier-table-wrap">
			<table class="bidding-price-tier-table">
				<thead>
					<tr>
						<th>name</th>
						<th>status</th>
						<th>floor</th>
						<th>ceiling</th>
						<th>delta</th>
						<th>parent</th>
						<th>order</th>
						<th>rev</th>
						<th>resolved</th>
						<th>error</th>
						<th>actions</th>
					</tr>
				</thead>
				<tbody>
					{#each activeTiers as tier, index (tier.tierId)}
						<BiddingPriceTierRow
							{tier}
							parentName={parentName(tier)}
							armedActionKey={armedActionKey}
							canMoveUp={index > 0}
							canMoveDown={index < activeTiers.length - 1}
							busy={busy}
							{nowMs}
							onEdit={editTier}
							onPreviewReapply={handlePreviewReapply}
							onMove={handleMove}
							onStatusChange={handleStatusChange}
							onArchive={handleArchive}
						/>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if reapplyTierId}
		<div class="bidding-price-tier-reapply-wrap">
			<div class="runtime-kv-grid bid-book-meta bidding-price-tier-meta">
				<div>
					<span class="runtime-k">reapply</span>
					<span class="runtime-v mono">{reapplyTierName ?? reapplyTierId}</span>
				</div>
			</div>
			<BiddingPriceTierReapplyPreview
				jobs={reapplyJobs}
				selectedJobIds={selectedReapplyJobIds}
				applying={reapplyApplying}
				armedActionKey={armedActionKey}
				onToggleJob={toggleReapplyJob}
				onApply={handleApplyReapply}
			/>
		</div>
	{/if}

	<form
		class="bootstrap-form bidding-price-tier-form"
		onsubmit={(event) => {
			event.preventDefault();
		}}
	>
		<div class="runtime-kv-grid token-bidding-runtime-grid bidding-price-tier-form-summary">
			<div>
				<span class="runtime-k">mode</span>
				<span class="runtime-v">{editingTier ? 'edit' : 'create'}</span>
			</div>
			{#if editingTier}
				<div>
					<span class="runtime-k">tier</span>
					<span class="runtime-v mono">{editingTier.tierId}</span>
				</div>
			{/if}
		</div>

		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-name"><span>name</span></label>
			<input
				id="bidding-price-tier-name"
				class="bootstrap-control bidding-price-tier-name-input"
				type="text"
				bind:value={name}
				disabled={busy}
			/>
		</div>

		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-parent"><span>parent</span></label>
			<select
				id="bidding-price-tier-parent"
				class="bootstrap-control bootstrap-input-select-medium"
				bind:value={parentTierId}
				disabled={busy}
			>
				<option value="">root</option>
				{#each activeTiers as tier}
					{#if tier.tierId !== editingTierId}
						<option value={tier.tierId}>{tier.name}</option>
					{/if}
				{/each}
			</select>
		</div>

		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-sort-order"><span>order</span></label>
			<input
				id="bidding-price-tier-sort-order"
				class="bootstrap-control bidding-price-tier-small-input"
				type="text"
				inputmode="numeric"
				bind:value={sortOrderText}
				disabled={busy}
			/>
		</div>

		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-floor-kind"><span>floor</span></label>
			<div class="bidding-price-tier-config-row">
				{#if hasParent}
					<select
						id="bidding-price-tier-floor-kind"
						class="bootstrap-control bootstrap-input-select-short"
						bind:value={floorKind}
						disabled={busy}
					>
						<option value={TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed}>fixed</option>
						<option value={TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta}>parent delta</option>
					</select>
				{:else}
					<span class="mono bidding-price-tier-fixed-kind">fixed</span>
				{/if}
				{#if !hasParent || floorKind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed}
					<input
						class="bootstrap-control bidding-price-tier-price-input"
						type="text"
						inputmode="decimal"
						placeholder="ETH"
						bind:value={floorValueEth}
						disabled={busy}
					/>
				{:else}
					<select
						class="bootstrap-control bidding-price-tier-delta-kind"
						bind:value={floorDeltaKind}
						disabled={busy}
					>
						<option value={TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute}>ETH</option>
						<option value={TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent}>%</option>
					</select>
					{#if floorDeltaKind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute}
						<input
							class="bootstrap-control bidding-price-tier-price-input"
							type="text"
							inputmode="decimal"
							bind:value={floorDeltaEth}
							disabled={busy}
						/>
					{:else}
						<input
							class="bootstrap-control bidding-price-tier-price-input"
							type="text"
							inputmode="decimal"
							bind:value={floorPercent}
							disabled={busy}
						/>
					{/if}
				{/if}
			</div>
		</div>

		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-ceiling-kind"><span>ceiling</span></label>
			<div class="bidding-price-tier-config-row">
				<select
					id="bidding-price-tier-ceiling-kind"
					class="bootstrap-control bootstrap-input-select-short"
					bind:value={ceilingKind}
					disabled={busy}
				>
					<option value={TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed}>fixed</option>
					<option value={TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta}>floor delta</option>
					{#if hasParent}
						<option value={TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta}>
							parent delta
						</option>
					{/if}
				</select>
				{#if ceilingKind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed}
					<input
						class="bootstrap-control bidding-price-tier-price-input"
						type="text"
						inputmode="decimal"
						placeholder="ETH"
						bind:value={ceilingValueEth}
						disabled={busy}
					/>
				{:else}
					<select
						class="bootstrap-control bidding-price-tier-delta-kind"
						bind:value={ceilingDeltaKind}
						disabled={busy}
					>
						<option value={TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute}>ETH</option>
						<option value={TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent}>%</option>
					</select>
					{#if ceilingDeltaKind === TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Absolute}
						<input
							class="bootstrap-control bidding-price-tier-price-input"
							type="text"
							inputmode="decimal"
							bind:value={ceilingDeltaEth}
							disabled={busy}
						/>
					{:else}
						<input
							class="bootstrap-control bidding-price-tier-price-input"
							type="text"
							inputmode="decimal"
							bind:value={ceilingPercent}
							disabled={busy}
						/>
					{/if}
				{/if}
			</div>
		</div>

		<div class="bootstrap-form-row">
			<label for="bidding-price-tier-delta"><span>price delta ETH</span></label>
			<input
				id="bidding-price-tier-delta"
				class="bootstrap-control bidding-price-tier-price-input"
				type="text"
				inputmode="decimal"
				bind:value={tierDeltaEth}
				disabled={busy}
			/>
		</div>

		<div class="panel-footer bidding-price-tier-form-footer">
			<button type="button" onclick={() => resetForm()} disabled={busy}>reset</button>
			<button
				type="button"
				class="token-bidding-action-positive"
				class:token-bidding-action-armed={armedActionKey ===
					(editingTier ? 'modify:form' : 'create:form')}
				data-price-tier-action={editingTier ? 'modify:form' : 'create:form'}
				onclick={() => void handleConfirmedSave(editingTier ? 'modify' : 'create')}
				disabled={editingTier ? !canModify : !canCreate}
			>
				{saving ? 'saving...' : editingTier ? 'modify' : 'create'}
			</button>
		</div>

		<div class="bootstrap-form-feedback bidding-price-tier-feedback">
			{#if saveMessage}
				<p class="runtime-pass token-bidding-feedback">{saveMessage}</p>
			{/if}
			{#if saveError}
				<p class="runtime-error token-bidding-feedback" role="alert">{saveError}</p>
			{/if}
		</div>
	</form>
</section>
