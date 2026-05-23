<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import type {
		ApiActivitiesPage,
		ApiActivityEventMedia,
		ApiActivityExtensionEventRef,
		ApiActivityFeedFilterKind,
		ApiActivityFeedItem,
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		ApiTokenPresentationSummary,
		ApiTraitFacet
	} from '$lib/api-types';
	import { resolveActivityExtensionEventView } from '$lib/activity-extension-views';
	import ActivityExtensionCellOutlet from '$lib/activity-extension-views/ActivityExtensionCellOutlet.svelte';
	import ActivityExtensionFiltersOutlet from '$lib/activity-extension-views/ActivityExtensionFiltersOutlet.svelte';
	import {
		ACTIVITY_TABLE_COLUMN_IDS,
		type ActivityExtensionFilterPatch,
		type ActivityExtensionFilterValues,
		type ActivityTableColumn,
		type ActivityTableColumnId
	} from '$lib/activity-extension-views/types';
	import { resolveActivityEventRenderMode } from '$lib/activity-event-render-mode';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import {
		buildCollectionNavigation,
		handleCollectionSectionShortcut
	} from '$lib/collection-navigation';
	import ActivityTokenCell from '$lib/components/ActivityTokenCell.svelte';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { formatListingPrice } from '$lib/listing-price';
	import TraitFacetPanel from '$lib/components/TraitFacetPanel.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import {
		getTokenPreviewController,
		TOKEN_PREVIEW_CONTEXT_KIND
	} from '$lib/components/token-preview-controller';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import {
		etherscanTransactionHref as buildEtherscanTransactionHref,
		openseaItemHref as buildOpenseaItemHref
	} from '$lib/marketplace-links';
	import { joinPath, normalizeBasePath } from '$lib/route-paths';
	import {
		collectionBiddingNavigationVisibilityForDeployment,
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import {
		nextSelectedTraits,
		setTraitRangeFilter
	} from '$lib/trait-filters';
	import { buildOwnerTokensHref, buildTokenDetailHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		activities,
		facets,
		selectedTraits,
		selectedTraitRanges,
		media,
		included,
		basePath,
		filterKind,
		extensionEvent = null,
		activityFilters = { tokenId: null, maker: null, contentHash: null, eventGroup: null }
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		activities: ApiActivitiesPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		media: ApiCollectionMediaState;
		included: {
			tokensById: Record<string, ApiTokenPresentationSummary>;
			eventMediaByActivityId: Record<string, ApiActivityEventMedia>;
			hasTraitSummaryTemplate: boolean;
		};
		basePath: string;
		filterKind: ApiActivityFeedFilterKind | null;
		extensionEvent?: ApiActivityExtensionEventRef | null;
		activityFilters?: ActivityExtensionFilterValues;
	} = $props();

	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;
	const RELATIVE_TIME_REFRESH_MS = 60_000;

	type TimeDisplayMode = 'relative' | 'system' | 'utc';

	const ACTIVITY_COLUMNS_BY_FILTER: Record<ApiActivityFeedFilterKind, readonly ActivityTableColumn[]> = {
		sales: [
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Media),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Price),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Id),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Name),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Traits),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.From),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.To),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Time)
		],
		listings: [
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Media),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Price),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Id),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Name),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Traits),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.From),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Time)
		],
		transfers: [
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Media),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Id),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Name),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Traits),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.From),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.To),
			standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Time)
		]
	};
	const EXTENSION_ACTIVITY_COLUMNS: readonly ActivityTableColumn[] = [
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Media),
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Id),
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Name),
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Traits),
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.From),
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Content),
		standardColumn(ACTIVITY_TABLE_COLUMN_IDS.Time)
	];
	const MONO_ACTIVITY_COLUMN_IDS = new Set<ActivityTableColumnId>([
		ACTIVITY_TABLE_COLUMN_IDS.Id,
		ACTIVITY_TABLE_COLUMN_IDS.Price,
		ACTIVITY_TABLE_COLUMN_IDS.From,
		ACTIVITY_TABLE_COLUMN_IDS.To,
		ACTIVITY_TABLE_COLUMN_IDS.Content,
		ACTIVITY_TABLE_COLUMN_IDS.Time,
		ACTIVITY_TABLE_COLUMN_IDS.Traits
	]);

	let timeDisplayMode = $state<TimeDisplayMode>('relative');
	let relativeNowMs = $state(Date.now());
	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let activeTraitRanges = $state<ApiTraitRangeFilter[]>(selectedTraitRanges);
	let tokenIdFilterDraft = $state(activityFilters.tokenId ?? '');
	let makerFilterDraft = $state(activityFilters.maker ?? '');
	let contentHashFilterDraft = $state(activityFilters.contentHash ?? '');
	let eventGroupFilterDraft = $state(activityFilters.eventGroup ?? '');
	let hasActiveFilters = $derived(activeTraits.length > 0 || activeTraitRanges.length > 0);
	let hasActiveActivityFilters = $derived(
		Boolean(
			activityFilters.tokenId ||
				activityFilters.maker ||
				activityFilters.contentHash ||
				activityFilters.eventGroup
		)
	);
	let hasActivityTraitSummaryColumn = $derived(included.hasTraitSummaryTemplate);
	let activeExtensionEventFeed = $derived(
		collection?.activityEventFeeds?.find(
			(feed) =>
				feed.extensionKey === extensionEvent?.extensionKey && feed.eventKey === extensionEvent?.eventKey
		) ?? null
	);
	let activeActivityExtensionEventView = $derived(
		extensionEvent ? resolveActivityExtensionEventView(extensionEvent) : null
	);
	let visibleColumns = $derived(
		activityColumns().filter(
			(column) => column.id !== ACTIVITY_TABLE_COLUMN_IDS.Traits || hasActivityTraitSummaryColumn
		)
	);

	$effect(() => {
		if (!browser || timeDisplayMode !== 'relative') return;
		const intervalId = window.setInterval(() => {
			relativeNowMs = Date.now();
		}, RELATIVE_TIME_REFRESH_MS);
		return () => window.clearInterval(intervalId);
	});

	$effect(() => {
		activeTraits = selectedTraits;
	});

	$effect(() => {
		activeTraitRanges = selectedTraitRanges;
	});

	$effect(() => {
		tokenIdFilterDraft = activityFilters.tokenId ?? '';
		makerFilterDraft = activityFilters.maker ?? '';
		contentHashFilterDraft = activityFilters.contentHash ?? '';
		eventGroupFilterDraft = activityFilters.eventGroup ?? '';
	});

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function collectionNavigation() {
		return buildCollectionNavigation({
			basePath,
			mediaMode: media.selectedMode,
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			token: {
				limit: activities.limit,
				displayMode: 'grid'
			},
			activity: {
				limit: activities.limit,
				kind: filterKind ?? undefined,
				extensionEvent
			},
			activityEventFeeds: collection?.activityEventFeeds ?? [],
			collectionExtensions: collection?.extensions ?? [],
			bidding: {
				...collectionBiddingNavigationVisibilityForDeployment()
			}
		});
	}

	function filterHref(
		nextKind: ApiActivityFeedFilterKind | null,
		cursor: string | null = null,
		traits: ApiTokenAttribute[] = activeTraits,
		traitRanges: ApiTraitRangeFilter[] = activeTraitRanges,
		filters: ActivityExtensionFilterValues = activityFilters
	): string {
		return buildCollectionActivityHref({
			basePath,
			limit: activities.limit,
			kind: nextKind,
			extensionEvent: nextKind ? null : extensionEvent,
			selectedTraits: traits,
			selectedTraitRanges: traitRanges,
			mediaMode: media.selectedMode,
			cursor,
			tokenId: filters.tokenId,
			maker: filters.maker,
			contentHash: filters.contentHash,
			eventGroup: filters.eventGroup
		});
	}

	function paginationHref(cursor: string | null): string {
		return filterHref(filterKind, cursor);
	}

	function holderHref(address: string): string {
		return buildOwnerTokensHref({
			basePath: joinPath(basePath, `holders/${encodeURIComponent(address)}`),
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: media.selectedMode
		});
	}

	function tokenDetailHref(tokenId: string): string {
		return buildTokenDetailHref({
			basePath: normalizeBasePath(basePath),
			tokenId,
			mediaMode: media.selectedMode
		});
	}

	function activityColumns(): readonly ActivityTableColumn[] {
		if (filterKind) return ACTIVITY_COLUMNS_BY_FILTER[filterKind];
		return activeActivityExtensionEventView?.columns ?? EXTENSION_ACTIVITY_COLUMNS;
	}

	function standardColumn(id: ActivityTableColumnId): ActivityTableColumn {
		return { id };
	}

	function mergeActivityFilterPatch(filters: ActivityExtensionFilterPatch): ActivityExtensionFilterValues {
		return {
			tokenId: filters.tokenId !== undefined ? filters.tokenId : activityFilters.tokenId,
			maker: filters.maker !== undefined ? filters.maker : activityFilters.maker,
			contentHash:
				filters.contentHash !== undefined ? filters.contentHash : activityFilters.contentHash,
			eventGroup:
				filters.eventGroup !== undefined ? filters.eventGroup : activityFilters.eventGroup
		};
	}

	function activityFilterHref(filters: ActivityExtensionFilterPatch): string {
		return filterHref(
			filterKind,
			null,
			activeTraits,
			activeTraitRanges,
			mergeActivityFilterPatch(filters)
		);
	}

	function activityCellHrefs() {
		return {
			filter: activityFilterHref,
			holder: holderHref,
			tokenDetail: tokenDetailHref
		};
	}

	function occurredAtLabel(occurredAt: number): string {
		if (timeDisplayMode === 'system') {
			return new Date(occurredAt * 1000).toLocaleString(undefined, {
				dateStyle: 'medium',
				timeStyle: 'medium'
			});
		}
		if (timeDisplayMode === 'utc') {
			return formatUtcTimestamp(occurredAt);
		}
		return formatRelativeTime(occurredAt, relativeNowMs);
	}

	function occurredAtTitle(occurredAt: number): string | undefined {
		if (timeDisplayMode !== 'relative') return undefined;
		return formatUtcTimestamp(occurredAt);
	}

	function tokenSummary(activity: ApiActivityFeedItem): ApiTokenPresentationSummary | null {
		if (!activity.tokenId) return null;
		return included.tokensById[activity.tokenId] ?? null;
	}

	function tokenName(activity: ApiActivityFeedItem): string | null {
		return tokenSummary(activity)?.name?.trim() || null;
	}

	function activityTraitSummary(activity: ApiActivityFeedItem): string | null {
		return tokenSummary(activity)?.traitSummary ?? null;
	}

	function marketplaceItemHref(activity: ApiActivityFeedItem): string | null {
		return buildOpenseaItemHref({
			chainSlug: chain?.slug ?? null,
			collectionAddress: collection?.address ?? null,
			tokenId: activity.tokenId
		});
	}

	function transactionHref(activity: ApiActivityFeedItem): string | null {
		return buildEtherscanTransactionHref(activity.txHash);
	}

	function activityPriceLabel(activity: ApiActivityFeedItem): string | null {
		return formatListingPrice(activity.price, activity.currency);
	}

	function activityFromAddress(activity: ApiActivityFeedItem): string | null {
		if (filterKind === 'listings') {
			return activity.maker;
		}
		if (!filterKind) {
			return activity.maker ?? activity.from;
		}
		return activity.from;
	}

	function activityContentHash(activity: ApiActivityFeedItem): string | null {
		const value = activity.payload?.contentHash;
		return typeof value === 'string' && value.trim() ? value : null;
	}

	function activityEventMedia(activity: ApiActivityFeedItem): ApiActivityEventMedia | null {
		return included.eventMediaByActivityId?.[String(activity.id)] ?? null;
	}

	function activityPreviewImage(activity: ApiActivityFeedItem): string | null {
		return activityEventMedia(activity)?.image ?? null;
	}

	function activityPreviewMode(activity: ApiActivityFeedItem): string {
		return resolveActivityEventRenderMode(media.selectedMode, activityEventMedia(activity)?.renderModes);
	}

	function activityPreviewModes(activity: ApiActivityFeedItem): ApiCollectionMediaState['availableModes'] {
		return activityEventMedia(activity)?.renderModes ?? media.availableModes;
	}

	function activityPreviewContext(activity: ApiActivityFeedItem) {
		return activityEventMedia(activity)
			? { kind: TOKEN_PREVIEW_CONTEXT_KIND.ActivityEvent, activityId: activity.id }
			: null;
	}

	function columnLabel(column: ActivityTableColumn): string {
		if (column.label) return column.label;
		switch (column.id) {
			case ACTIVITY_TABLE_COLUMN_IDS.Id:
				return 'id';
			case ACTIVITY_TABLE_COLUMN_IDS.Price:
				return 'price';
			case ACTIVITY_TABLE_COLUMN_IDS.Media:
				return 'media';
			case ACTIVITY_TABLE_COLUMN_IDS.Name:
				return 'name';
			case ACTIVITY_TABLE_COLUMN_IDS.Traits:
				return 'traits';
			case ACTIVITY_TABLE_COLUMN_IDS.From:
				return 'from';
			case ACTIVITY_TABLE_COLUMN_IDS.To:
				return 'to';
			case ACTIVITY_TABLE_COLUMN_IDS.Content:
				return 'content';
			case ACTIVITY_TABLE_COLUMN_IDS.Time:
				return 'time';
			default:
				return column.id;
		}
	}

	function columnIsMono(column: ActivityTableColumn): boolean {
		return column.mono ?? MONO_ACTIVITY_COLUMN_IDS.has(column.id as ActivityTableColumnId);
	}

	function maskAddress(address: string | null): string | null {
		if (!address) return null;
		if (address.length <= 10) return address;
		return `${address.slice(0, 6)}...${address.slice(-4)}`;
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
		if (event.defaultPrevented || $keyboardShortcutsHelpState.open) {
			return;
		}

		const previewWasOpen = $tokenPreviewState.open;
		tokenPreview.onWindowKeydown(event);
		if (previewWasOpen) {
			return;
		}

		if (
			handleCollectionSectionShortcut(event, collectionNavigation())
		) {
			return;
		}

		traitFacetPanel.onWindowKeydown(event, {
			onReset: onResetAllFilters
		});
	}

	function cycleTimeDisplayMode(): void {
		timeDisplayMode =
			timeDisplayMode === 'relative'
				? 'system'
				: timeDisplayMode === 'system'
					? 'utc'
					: 'relative';
		if (timeDisplayMode === 'relative') {
			relativeNowMs = Date.now();
		}
	}

	function timeDisplayModeLabel(): string {
		switch (timeDisplayMode) {
			case 'system':
				return 'system';
			case 'utc':
				return 'utc';
			default:
				return 'relative';
		}
	}

	function formatRelativeTime(occurredAt: number, nowMs: number): string {
		const deltaSeconds = Math.max(0, Math.floor(nowMs / 1000) - occurredAt);
		if (deltaSeconds < 5) return 'just now';
		if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
		const minutes = Math.floor(deltaSeconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		if (months < 12) return `${months}mo ago`;
		const years = Math.floor(days / 365);
		return `${years}y ago`;
	}

	function activityUtcDayStart(activity: ApiActivityFeedItem): number {
		if (activity.collapsedWindowStartUtc !== null) {
			return activity.collapsedWindowStartUtc;
		}
		return Math.floor(activity.occurredAt / 86_400) * 86_400;
	}

	function shouldRenderUtcDayBreak(index: number): boolean {
		if (index <= 0) return false;
		return (
			activityUtcDayStart(activities.items[index]!) !== activityUtcDayStart(activities.items[index - 1]!)
		);
	}

	function formatUtcDayLabel(activity: ApiActivityFeedItem): string {
		return `${new Date(activityUtcDayStart(activity) * 1000).toISOString().slice(0, 10)} UTC`;
	}

	function formatUtcTimestamp(occurredAt: number): string {
		return new Date(occurredAt * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
	}

	async function applyTraitFilters(
		nextTraits: ApiTokenAttribute[],
		nextRanges: ApiTraitRangeFilter[]
	): Promise<void> {
		activeTraits = nextTraits;
		activeTraitRanges = nextRanges;
		await goto(filterHref(filterKind, null, nextTraits, nextRanges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onTraitToggleWithMode(
		key: string,
		value: string,
		checked: boolean,
		exclusiveMode: boolean
	): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked, exclusiveMode);
		await applyTraitFilters(nextTraits, activeTraitRanges);
	}

	async function onApplyTraitRange(
		key: string,
		fromValue: string | null,
		toValue: string | null
	): Promise<void> {
		const nextRanges = setTraitRangeFilter(activeTraitRanges, key, fromValue, toValue);
		await applyTraitFilters(activeTraits, nextRanges);
	}

	async function onResetFilters(): Promise<void> {
		await applyTraitFilters([], []);
	}

	async function onResetAllFilters(): Promise<void> {
		activeTraits = [];
		activeTraitRanges = [];
		tokenIdFilterDraft = '';
		makerFilterDraft = '';
		contentHashFilterDraft = '';
		eventGroupFilterDraft = '';
		await goto(
			filterHref(filterKind, null, [], [], {
				tokenId: null,
				maker: null,
				contentHash: null,
				eventGroup: null
			}),
			{
				invalidateAll: true,
				keepFocus: true,
				noScroll: true
			}
		);
	}

	async function onApplyActivityFilters(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		await goto(
			filterHref(filterKind, null, activeTraits, activeTraitRanges, {
				tokenId: tokenIdFilterDraft.trim() || null,
				maker: makerFilterDraft.trim() || null,
				contentHash: contentHashFilterDraft.trim() || null,
				eventGroup: eventGroupFilterDraft.trim() || null
			}),
			{
				invalidateAll: true,
				keepFocus: true,
				noScroll: true
			}
		);
	}

	async function onApplyActivityFilterPatch(filters: ActivityExtensionFilterPatch): Promise<void> {
		await goto(activityFilterHref(filters), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onClearActivityFilters(): Promise<void> {
		tokenIdFilterDraft = '';
		makerFilterDraft = '';
		contentHashFilterDraft = '';
		eventGroupFilterDraft = '';
		await goto(
			filterHref(filterKind, null, activeTraits, activeTraitRanges, {
				tokenId: null,
				maker: null,
				contentHash: null,
				eventGroup: null
			}),
			{
				invalidateAll: true,
				keepFocus: true,
				noScroll: true
			}
		);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<CollectionPageLayout
	navigation={collectionNavigation()}
	activeSection="activities"
	activeActivityKind={filterKind}
	activeActivityExtensionEvent={extensionEvent}
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">events</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={collectionNavigation().hrefs.asks}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">events</span>
			{/if}
		{/if}
	{/snippet}
	{#snippet headerActions()}
		{#if collection}
			<CollectionJumpForm chainRef={chain?.slug ?? ''} basePath={basePath} mediaMode={media.selectedMode} />
		{/if}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}
	{#snippet topActions()}
		<div class="panel-top-actions-row">
			<TraitFacetPanelControls
				hasActiveFilters={hasActiveFilters || hasActiveActivityFilters}
				collapsed={$traitFacetPanelState.collapsed}
				onToggleCollapsed={traitFacetPanel.toggle}
				onReset={onResetAllFilters}
				selectedTraits={activeTraits}
				selectedRanges={activeTraitRanges}
				onSelectedFiltersChange={applyTraitFilters}
			/>
		</div>
		{#if activeExtensionEventFeed && activeActivityExtensionEventView?.Filters}
			<ActivityExtensionFiltersOutlet
				Filters={activeActivityExtensionEventView.Filters}
				chainRef={chain?.slug ?? ''}
				feed={activeExtensionEventFeed}
				filters={activityFilters}
				onApply={onApplyActivityFilterPatch}
			/>
		{:else if activeExtensionEventFeed?.filters}
			<form class="activity-extension-filters" onsubmit={onApplyActivityFilters}>
				{#if activeExtensionEventFeed.filters.tokenId}
					<label class="activity-extension-filter-field">
						<span>{activeExtensionEventFeed.filters.tokenId.label}</span>
						<input
							class="activity-extension-filter-input activity-extension-filter-input-token"
							type="text"
							inputmode="numeric"
							bind:value={tokenIdFilterDraft}
							autocomplete="off"
						/>
					</label>
				{/if}
				{#if activeExtensionEventFeed.filters.maker}
					<label class="activity-extension-filter-field">
						<span>{activeExtensionEventFeed.filters.maker.label}</span>
						<input
							class="activity-extension-filter-input activity-extension-filter-input-maker"
							type="text"
							bind:value={makerFilterDraft}
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
						/>
					</label>
				{/if}
				{#if activeExtensionEventFeed.filters.contentHash}
					<label class="activity-extension-filter-field">
						<span>{activeExtensionEventFeed.filters.contentHash.label}</span>
						<input
							class="activity-extension-filter-input activity-extension-filter-input-hash"
							type="text"
							bind:value={contentHashFilterDraft}
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
						/>
					</label>
				{/if}
				{#if activeExtensionEventFeed.filters.eventGroup}
					<label class="activity-extension-filter-field">
						<span>{activeExtensionEventFeed.filters.eventGroup.label}</span>
						<select
							class="activity-extension-filter-input activity-extension-filter-input-event-group"
							bind:value={eventGroupFilterDraft}
						>
							<option value=""></option>
							{#each activeExtensionEventFeed.filters.eventGroup.options as option}
								<option value={option.key}>{option.label}</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if hasActiveActivityFilters || tokenIdFilterDraft.trim() || makerFilterDraft.trim() || contentHashFilterDraft.trim() || eventGroupFilterDraft.trim()}
					<button
						class="facet-panel-action-button facet-reset-button activity-extension-filter-clear"
						type="button"
						onclick={onClearActivityFilters}
					>
						clear
					</button>
				{/if}
			</form>
		{/if}
	{/snippet}

	<div class="detail-layout" class:sidebar-collapsed={$traitFacetPanelState.collapsed}>
		<TraitFacetPanel
			{facets}
			selectedTraits={activeTraits}
			selectedRanges={activeTraitRanges}
			collapsed={$traitFacetPanelState.collapsed}
			onToggleTrait={onTraitToggleWithMode}
			onApplyTraitRange={onApplyTraitRange}
		/>

		<div class="activity-panel">
			<div class="table-wrap activities-table-wrap">
					<table class="activities-table">
						<colgroup>
							{#each visibleColumns as column}
								<col class={`activities-${column.id}-col`} />
							{/each}
						</colgroup>
						<thead>
							<tr>
								{#each visibleColumns as column}
									<th class={`activities-${column.id}-col`}>
										{#if column.id === ACTIVITY_TABLE_COLUMN_IDS.Time}
											<span>{columnLabel(column)}</span>
											<button
											type="button"
											class="activities-time-mode-button"
											aria-label="cycle time display mode"
											onclick={cycleTimeDisplayMode}
										>
											{timeDisplayModeLabel()}
										</button>
									{:else}
										{columnLabel(column)}
									{/if}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#if activities.items.length === 0}
							<tr>
								<td colspan={visibleColumns.length} class="empty-cell">no activities found</td>
							</tr>
						{:else}
							{#each activities.items as activity, index (activity.id)}
								{#if shouldRenderUtcDayBreak(index)}
									<tr class="activities-day-break-row">
										<td colspan={visibleColumns.length}>
											<span class="activities-day-break-label">{formatUtcDayLabel(activity)}</span>
										</td>
									</tr>
								{/if}
								<tr>
									{#each visibleColumns as column}
										<td class={`activities-${column.id}-cell${columnIsMono(column) ? ' mono' : ''}`}>
											{#if column.Cell}
												<ActivityExtensionCellOutlet
													Cell={column.Cell}
													{activity}
													token={tokenSummary(activity)}
													eventMedia={activityEventMedia(activity)}
													hrefs={activityCellHrefs()}
												/>
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Id}
												{#if activity.tokenId}
													<a href={tokenDetailHref(activity.tokenId)}>{activity.tokenId}</a>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Price}
												{#if activityPriceLabel(activity)}
													{#if marketplaceItemHref(activity)}
														<a
															href={marketplaceItemHref(activity) ?? '#'}
															target="_blank"
															rel="noreferrer noopener"
														>
															{activityPriceLabel(activity)}
														</a>
													{:else}
														{activityPriceLabel(activity)}
													{/if}
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Media}
												<ActivityTokenCell
													chainRef={chain?.slug ?? null}
													collectionRef={collection?.slug ?? null}
													tokenId={activity.tokenId}
													token={tokenSummary(activity)}
													imageOverride={activityPreviewImage(activity)}
													selectedMediaMode={activityPreviewMode(activity)}
													availableMediaModes={activityPreviewModes(activity)}
													previewContext={activityPreviewContext(activity)}
													tokenPreview={tokenPreview}
												/>
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Name}
												{#if tokenName(activity)}
													<span class="activities-name-text" title={tokenName(activity) ?? undefined}>
														{tokenName(activity)}
													</span>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Traits}
												{#if activityTraitSummary(activity)}
													<span title={activityTraitSummary(activity) ?? undefined}>
														{activityTraitSummary(activity)}
													</span>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.From}
												{#if activityFromAddress(activity)}
													<a
														href={holderHref(activityFromAddress(activity) ?? '')}
														title={activityFromAddress(activity) ?? undefined}
													>
														{maskAddress(activityFromAddress(activity))}
													</a>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.To}
												{#if activity.to}
													<a href={holderHref(activity.to)} title={activity.to}>
														{maskAddress(activity.to)}
													</a>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Content}
												{#if activityContentHash(activity)}
													<span title={activityContentHash(activity) ?? undefined}>
														{maskAddress(activityContentHash(activity))}
													</span>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column.id === ACTIVITY_TABLE_COLUMN_IDS.Time}
												{#if transactionHref(activity)}
													<a
														href={transactionHref(activity) ?? '#'}
														target="_blank"
														rel="noreferrer noopener"
														title={occurredAtTitle(activity.occurredAt)}
													>
														{occurredAtLabel(activity.occurredAt)}
													</a>
												{:else}
													<span title={occurredAtTitle(activity.occurredAt)}>
														{occurredAtLabel(activity.occurredAt)}
													</span>
												{/if}
											{/if}
										</td>
									{/each}
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>

			<footer class="panel-footer activities-summary">
				<div class="pagination-summary">
					{#if activities.totalItems === 0}
						<span class="muted">showing 0 of 0</span>
					{:else}
						<span class="mono">showing {activities.rangeStart}-{activities.rangeEnd} of {activities.totalItems}</span>
						<span class="muted">page {activities.currentPage} / {activities.totalPages}</span>
					{/if}
				</div>
				<div class="pagination-summary">
					{#if activities.prevCursor}
						<a class="button-link" href={paginationHref(activities.prevCursor)}>newer</a>
					{/if}
					{#if activities.nextCursor}
						<a class="button-link" href={paginationHref(activities.nextCursor)}>older</a>
					{/if}
				</div>
			</footer>
		</div>
	</div>
</CollectionPageLayout>
