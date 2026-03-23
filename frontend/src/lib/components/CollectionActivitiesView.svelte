<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import type {
		ApiActivitiesPage,
		ApiActivityFeedFilterKind,
		ApiActivityFeedItem,
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTokenPresentationSummary,
		ApiTraitFacet
	} from '$lib/api-types';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import ActivityTokenCell from '$lib/components/ActivityTokenCell.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import TraitFacetPanel from '$lib/components/TraitFacetPanel.svelte';
	import TraitFacetPanelControls from '$lib/components/TraitFacetPanelControls.svelte';
	import TokenPreviewOverlay from '$lib/components/TokenPreviewOverlay.svelte';
	import { createTokenPreviewController } from '$lib/components/token-preview-controller';
	import { createTraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import {
		etherscanTransactionHref as buildEtherscanTransactionHref,
		openseaItemHref as buildOpenseaItemHref
	} from '$lib/marketplace-links';
	import { nextSelectedTraits } from '$lib/trait-filters';
	import { buildOwnerTokensHref, buildTokenBrowserHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		activities,
		facets,
		selectedTraits,
		media,
		included,
		basePath,
		filterKind
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		activities: ApiActivitiesPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		media: ApiCollectionMediaState;
		included: {
			tokensById: Record<string, ApiTokenPresentationSummary>;
		};
		basePath: string;
		filterKind: ApiActivityFeedFilterKind;
	} = $props();

	const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
	const WEI_BASE = 10n ** 18n;
	const tokenPreview = createTokenPreviewController(fetch);
	const tokenPreviewState = tokenPreview.state;
	const traitFacetPanel = createTraitFacetPanelController();
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;
	const RELATIVE_TIME_REFRESH_MS = 60_000;

	type TimeDisplayMode = 'relative' | 'system' | 'utc';
	type ActivityColumnId = 'id' | 'price' | 'image' | 'name' | 'from' | 'to' | 'time';

	const ACTIVITY_COLUMNS_BY_FILTER: Record<ApiActivityFeedFilterKind, ActivityColumnId[]> = {
		sales: ['id', 'price', 'image', 'name', 'from', 'to', 'time'],
		listings: ['id', 'price', 'image', 'name', 'from', 'time'],
		transfers: ['id', 'image', 'name', 'from', 'to', 'time']
	};

	let timeDisplayMode = $state<TimeDisplayMode>('relative');
	let relativeNowMs = $state(Date.now());
	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let hasActiveFilters = $derived(activeTraits.length > 0);
	let visibleColumns = $derived(ACTIVITY_COLUMNS_BY_FILTER[filterKind]);

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

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function tokensHref(): string {
		return buildTokenBrowserHref({
			basePath,
			limit: activities.limit,
			displayMode: 'grid',
			tokenStatus: 'listed',
			selectedTraits: activeTraits,
			mediaMode: media.selectedMode
		});
	}

	function activitiesHref(): string {
		return buildCollectionActivityHref({
			basePath,
			limit: activities.limit,
			kind: filterKind,
			selectedTraits: activeTraits,
			mediaMode: media.selectedMode
		});
	}

	function holdersHref(): string {
		const query = new URLSearchParams();
		query.set('media_mode', media.selectedMode);
		return `${basePath}/holders?${query.toString()}`;
	}

	function filterHref(
		nextKind: ApiActivityFeedFilterKind,
		cursor: string | null = null,
		traits: ApiTokenAttribute[] = activeTraits
	): string {
		return buildCollectionActivityHref({
			basePath,
			limit: activities.limit,
			kind: nextKind,
			selectedTraits: traits,
			mediaMode: media.selectedMode,
			cursor
		});
	}

	function paginationHref(cursor: string | null): string {
		return filterHref(filterKind, cursor);
	}

	function holderHref(address: string): string {
		return buildOwnerTokensHref({
			basePath: `${basePath}/holders/${encodeURIComponent(address)}`,
			selectedTraits: [],
			mediaMode: media.selectedMode
		});
	}

	function tokenDetailHref(tokenId: string): string {
		const query = new URLSearchParams();
		query.set('media_mode', media.selectedMode);
		return `${basePath}/${encodeURIComponent(tokenId)}?${query.toString()}`;
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

	function currencyLabel(currency: string | null): string | null {
		if (!currency) return null;
		return currency.toLowerCase() === ZERO_ADDRESS ? 'ETH' : 'WETH';
	}

	function formatPrice(rawPrice: string | null, currency: string | null): string | null {
		if (!rawPrice || !currency || !/^\d+$/.test(rawPrice)) return null;
		const value = BigInt(rawPrice);
		const whole = value / WEI_BASE;
		const fraction = value % WEI_BASE;
		const fractionText = fraction.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
		const amount = fractionText ? `${whole}.${fractionText}` : `${whole}`;
		return `${amount} ${currencyLabel(currency)}`;
	}

	function tokenSummary(activity: ApiActivityFeedItem): ApiTokenPresentationSummary | null {
		if (!activity.tokenId) return null;
		return included.tokensById[activity.tokenId] ?? null;
	}

	function tokenName(activity: ApiActivityFeedItem): string | null {
		return tokenSummary(activity)?.name?.trim() || null;
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
		return formatPrice(activity.price, activity.currency);
	}

	function activityFromAddress(activity: ApiActivityFeedItem): string | null {
		if (filterKind === 'listings') {
			return activity.maker;
		}
		return activity.from;
	}

	function columnLabel(column: ActivityColumnId): string {
		switch (column) {
			case 'id':
				return 'id';
			case 'price':
				return 'price';
			case 'image':
				return 'image';
			case 'name':
				return 'name';
			case 'from':
				return 'from';
			case 'to':
				return 'to';
			case 'time':
				return 'time';
		}
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

		traitFacetPanel.onWindowKeydown(event, {
			onReset: onResetFilters
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

	async function onTraitToggleWithMode(
		key: string,
		value: string,
		checked: boolean,
		exclusiveMode: boolean
	): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked, exclusiveMode);
		activeTraits = nextTraits;
		await goto(filterHref(filterKind, null, nextTraits), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onResetFilters(): Promise<void> {
		activeTraits = [];
		await goto(filterHref(filterKind, null, []), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<CollectionPageLayout
	tokensHref={tokensHref()}
	activitiesHref={activitiesHref()}
	holdersHref={holdersHref()}
	activeSection="activities"
	collectionAvailable={collection !== null}
>
	{#snippet breadcrumbs()}
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<a href={tokensHref()}>{collection.slug}</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">activities</span>
		{/if}
	{/snippet}
	{#snippet headerActions()}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}
	{#snippet topActions()}
		<div class="panel-top-actions-row">
			<div class="secondary-tabs" aria-label="Activity type filters">
				{#if filterKind === 'sales'}
					<span class="secondary-tab-active">sales</span>
				{:else}
					<a href={filterHref('sales')}>sales</a>
				{/if}
				{#if filterKind === 'listings'}
					<span class="secondary-tab-active">listings</span>
				{:else}
					<a href={filterHref('listings')}>listings</a>
				{/if}
				{#if filterKind === 'transfers'}
					<span class="secondary-tab-active">transfers</span>
				{:else}
					<a href={filterHref('transfers')}>transfers</a>
				{/if}
			</div>
		</div>
		<div class="panel-top-actions-row">
			<TraitFacetPanelControls
				hasActiveFilters={hasActiveFilters}
				collapsed={$traitFacetPanelState.collapsed}
				onToggleCollapsed={traitFacetPanel.toggle}
				onReset={onResetFilters}
			/>
		</div>
	{/snippet}

	<div class="detail-layout" class:sidebar-collapsed={$traitFacetPanelState.collapsed}>
		<TraitFacetPanel
			{facets}
			selectedTraits={activeTraits}
			collapsed={$traitFacetPanelState.collapsed}
			onToggleTrait={onTraitToggleWithMode}
		/>

		<div class="activity-panel">
			<div class="table-wrap activities-table-wrap">
				<table class="activities-table">
					<colgroup>
						{#each visibleColumns as column}
							<col class={`activities-${column}-col`} />
						{/each}
					</colgroup>
					<thead>
						<tr>
							{#each visibleColumns as column}
								<th class={`activities-${column}-col`}>
									{#if column === 'time'}
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
										<td class={`activities-${column}-cell${column === 'id' || column === 'price' || column === 'from' || column === 'to' || column === 'time' ? ' mono' : ''}`}>
											{#if column === 'id'}
												{#if activity.tokenId}
													<a href={tokenDetailHref(activity.tokenId)}>{activity.tokenId}</a>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column === 'price'}
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
											{:else if column === 'image'}
												<ActivityTokenCell
													chainRef={chain?.slug ?? null}
													collectionRef={collection?.slug ?? null}
													tokenId={activity.tokenId}
													token={tokenSummary(activity)}
													selectedMediaMode={media.selectedMode}
													availableMediaModes={media.availableModes}
													tokenPreview={tokenPreview}
												/>
											{:else if column === 'name'}
												{#if tokenName(activity)}
													<span class="activities-name-text" title={tokenName(activity) ?? undefined}>
														{tokenName(activity)}
													</span>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column === 'from'}
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
											{:else if column === 'to'}
												{#if activity.to}
													<a href={holderHref(activity.to)} title={activity.to}>
														{maskAddress(activity.to)}
													</a>
												{:else}
													<span class="muted">-</span>
												{/if}
											{:else if column === 'time'}
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

<TokenPreviewOverlay
	state={$tokenPreviewState}
	closeTokenPreview={tokenPreview.closeTokenPreview}
	tokenPreview={tokenPreview}
/>
