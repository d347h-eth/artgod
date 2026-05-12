<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
		ApiTokenCard,
		ApiTraitRangeFilter,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import TraitFacetPanel from '$lib/components/TraitFacetPanel.svelte';
	import TokenMediaPreviewTrigger from '$lib/components/TokenMediaPreviewTrigger.svelte';
	import {
		handleCollectionSectionShortcut,
		type CollectionNavigation
	} from '$lib/collection-navigation';
	import type { KeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
	import type { TraitFacetPanelController } from '$lib/components/trait-facet-panel-controller';
	import CursorPaginationControls from '$lib/components/CursorPaginationControls.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import { formatListingPrice } from '$lib/listing-price';
	import { openseaItemHref as buildOpenseaItemHref } from '$lib/marketplace-links';
	import { buildTokenBrowserHref, buildTokenDetailHref } from '$lib/token-browser-query';
	import type {
		TokenCardSelectionState,
		TokenCardSelectionToggleRequest
	} from '$lib/token-card-selection';
	import {
		appendTraitParams,
		appendTraitRangeParams,
		nextSelectedTraits,
		setTraitRangeFilter
	} from '$lib/trait-filters';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import {
		buildPaginationWindowSignature,
		describePaginationWindow,
		pageToPaginationWindow,
		readPaginationWindow,
		resolvePaginationWindow,
		traitFilterPaginationSignatureParts,
		writePaginationWindow
	} from '$lib/components/pagination-window';
	import { buildAskMarketPrice, type MarketPriceItem } from '$lib/market-price';
	import { appendMediaModeParam, nextMediaMode } from '$lib/media-mode';

	type MaybePromise<T> = T | Promise<T>;

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		selectedTraitRanges,
		media,
		collectionBasePath,
		browserBasePath,
		requestCursor,
		onResetTraits,
		traitFacetPanel,
		keyboardShortcutsHelp,
		collectionNavigation = null,
		tokenStatus,
		displayMode,
		emptyMessage = 'no tokens match current filters',
		selection = null
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		media: ApiCollectionMediaState;
		collectionBasePath: string;
		browserBasePath: string;
		requestCursor: string | null;
		onResetTraits: () => MaybePromise<void>;
		traitFacetPanel: TraitFacetPanelController;
		keyboardShortcutsHelp: KeyboardShortcutsHelpController;
		collectionNavigation?: CollectionNavigation | null;
		tokenStatus: 'listed' | 'all' | 'listed_then_unlisted';
		displayMode: 'grid' | 'table';
		emptyMessage?: string;
		selection?: {
			summary: string | null;
			state: (tokenId: string) => TokenCardSelectionState;
			onSelectAll: () => void;
			onClear: () => void;
			onToggle: (request: TokenCardSelectionToggleRequest & { visibleTokenIds: string[] }) => void;
		} | null;
	} = $props();

	const TRAIT_COLUMN_PRIORITY = ['Mode', 'Zone', 'Biome', 'x', 'y', 'Level', 'Chroma', '???'];
	const tokenPreview = getTokenPreviewController();
	const tokenPreviewState = tokenPreview.state;
	const traitFacetPanelState = traitFacetPanel.state;
	const keyboardShortcutsHelpState = keyboardShortcutsHelp.state;

	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let activeTraitRanges = $state<ApiTraitRangeFilter[]>(selectedTraitRanges);
	let visibleTokens = $state<ApiTokenCard[]>(tokens.items);
	let visibleRangeStart = $state(tokens.rangeStart);
	let visibleRangeEnd = $state(tokens.rangeEnd);
	let pagesLoaded = $state(tokens.items.length === 0 ? 0 : 1);
	let pagingPending = $state(false);
	let headPrevCursor = $state<string | null>(tokens.prevCursor);
	let tailNextCursor = $state<string | null>(tokens.nextCursor);
	let paginationMetrics = $derived(
		describePaginationWindow({
			totalItems: tokens.totalItems,
			rangeStart: visibleRangeStart,
			rangeEnd: visibleRangeEnd,
			limit: tokens.limit,
			tailNextCursor
		})
	);
	let isGridMode = $derived(displayMode === 'grid');
	let showDisplayModeControls = false;
	let hasMediaModeChoices = $derived(media.availableModes.length > 1);
	let traitColumns = $derived(resolveTraitColumns(facets));
	let traitFacetIndex = $derived(buildTraitFacetIndex(facets));
	let visibleTokenIds = $derived(visibleTokens.map((token) => token.tokenId));

	$effect(() => {
		activeTraits = selectedTraits;
	});

	$effect(() => {
		activeTraitRanges = selectedTraitRanges;
	});

	$effect(() => {
		const signature = filtersSignature(
			selectedTraits,
			selectedTraitRanges,
			tokens.limit,
			displayMode,
			tokenStatus,
			media.selectedMode
		);
		const incoming = pageToPaginationWindow(tokens);
		const cached = browser ? readPaginationWindow<ApiTokenCard>(signature) : null;
		const resolved = resolvePaginationWindow({
			cached,
			incoming,
			requestCursor,
			itemKey: (token) => token.tokenId
		});

		visibleTokens = resolved.items;
		visibleRangeStart = resolved.rangeStart;
		visibleRangeEnd = resolved.rangeEnd;
		pagesLoaded = resolved.pagesLoaded;
		headPrevCursor = resolved.headPrevCursor;
		tailNextCursor = resolved.tailNextCursor;

		if (browser) {
			writePaginationWindow(signature, resolved);
		}

		pagingPending = false;
	});

	function loadPreviousHref(): string {
		if (!paginationMetrics.hasPreviousPage) return '#';
		return buildFiltersHref(activeTraits, activeTraitRanges, headPrevCursor);
	}

	function loadNextHref(): string {
		if (!tailNextCursor) return '#';
		return buildFiltersHref(activeTraits, activeTraitRanges, tailNextCursor);
	}

	function tokenDetailHref(tokenId: string): string {
		return buildTokenDetailHref({
			basePath: collectionBasePath,
			tokenId,
			mediaMode: media.selectedMode,
			returnPath: browserBasePath,
			returnQuery: buildReturnQuery()
		});
	}

	function buildReturnQuery(): string {
		const query = new URLSearchParams();
		query.set('limit', String(tokens.limit));
		query.set('mode', displayMode);
		query.set('token_status', tokenStatus);
		query.set('media_mode', media.selectedMode);
		if (requestCursor) {
			query.set('cursor', requestCursor);
		}
		appendTraitParams(query, activeTraits);
		appendTraitRangeParams(query, activeTraitRanges);
		return query.toString();
	}

	function tokenTraitsLabel(token: ApiTokenCard): string {
		if (token.attributes.length === 0) return 'no traits';
		return token.attributes.map((item) => `${item.key}:${item.value}`).join(' | ');
	}

	function browserResultsSummary(): string {
		if (tokenStatus === 'listed') {
			return `${tokens.totalItems} listed`;
		}
		if (tokenStatus === 'listed_then_unlisted') {
			return `${tokens.totalItems} held`;
		}
		return `${tokens.totalItems} total`;
	}

	function tokenListingLabel(token: ApiTokenCard): string | null {
		return formatListingPrice(token.listingPrice, token.listingCurrency);
	}

	function openseaItemHref(token: ApiTokenCard): string | null {
		return buildOpenseaItemHref({
			chainSlug: chain?.slug ?? null,
			collectionAddress: collection?.address ?? null,
			tokenId: token.tokenId
		});
	}

	function tokenMarketPrices(token: ApiTokenCard): MarketPriceItem[] {
		const ask = buildAskMarketPrice({
			rawPrice: token.listingPrice,
			currencyAddress: token.listingCurrency,
			href: openseaItemHref(token),
			title: 'ask'
		});
		return ask ? [ask] : [];
	}

	function buildFiltersHref(
		traits: ApiTokenAttribute[],
		traitRanges: ApiTraitRangeFilter[] = activeTraitRanges,
		cursor: string | null = null,
		mode: 'grid' | 'table' = displayMode,
		nextTokenStatus: 'listed' | 'all' | 'listed_then_unlisted' = tokenStatus
	): string {
		return buildTokenBrowserHref({
			basePath: browserBasePath,
			limit: tokens.limit,
			displayMode: mode,
			tokenStatus: nextTokenStatus,
			selectedTraits: traits,
			selectedTraitRanges: traitRanges,
			mediaMode: media.selectedMode,
			cursor
		});
	}

	function filtersSignature(
		traits: ApiTokenAttribute[],
		traitRanges: ApiTraitRangeFilter[],
		limit: number,
		mode: 'grid' | 'table',
		activeTokenStatus: 'listed' | 'all' | 'listed_then_unlisted',
		activeMediaMode: string
	): string {
		return buildPaginationWindowSignature([
			browserBasePath,
			limit,
			mode,
			activeTokenStatus,
			activeMediaMode,
			...traitFilterPaginationSignatureParts({ traits, ranges: traitRanges })
		]);
	}

	function resolveTraitColumns(input: ApiTraitFacet[]): string[] {
		if (input.length === 0) return [];

		const available = new Set(input.map((facet) => facet.key));
		const resolved: string[] = [];

		for (const key of TRAIT_COLUMN_PRIORITY) {
			if (!available.has(key)) continue;
			resolved.push(key);
			available.delete(key);
		}

		const extras = [...available].sort((a, b) => a.localeCompare(b));
		for (const key of extras) {
			resolved.push(key);
		}

		return resolved.slice(0, 8);
	}

	function buildTraitFacetIndex(input: ApiTraitFacet[]): Map<string, Map<string, number>> {
		const index = new Map<string, Map<string, number>>();
		for (const facet of input) {
			const values = new Map<string, number>();
			for (const item of facet.values) {
				values.set(item.value, item.tokenCount);
			}
			index.set(facet.key, values);
		}
		return index;
	}

	function tokenTraitValue(token: ApiTokenCard, key: string): string | null {
		for (const attr of token.attributes) {
			if (attr.key === key) return attr.value;
		}
		return null;
	}

	function traitStatsLabel(key: string, value: string): string | null {
		const byValue = traitFacetIndex.get(key);
		const count = byValue?.get(value);
		if (count === undefined || tokens.totalItems <= 0) return null;
		const pct = ((count / tokens.totalItems) * 100).toFixed(2);
		return `${count} (${pct}%)`;
	}

	function modeHref(mode: 'grid' | 'table'): string {
		return buildFiltersHref(activeTraits, activeTraitRanges, requestCursor, mode);
	}

	function mediaModeHref(nextMediaMode: string): string {
		return buildTokenBrowserHref({
			basePath: browserBasePath,
			limit: tokens.limit,
			displayMode,
			tokenStatus,
			selectedTraits: activeTraits,
			selectedTraitRanges: activeTraitRanges,
			mediaMode: nextMediaMode,
			cursor: requestCursor
		});
	}

	function nextPageMediaMode(): string | null {
		if (media.availableModes.length <= 1) {
			return null;
		}
		return nextMediaMode(media.availableModes, media.selectedMode);
	}

	async function onTraitToggleWithMode(
		key: string,
		value: string,
		checked: boolean,
		exclusiveMode: boolean
	): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked, exclusiveMode);
		activeTraits = nextTraits;
		await goto(buildFiltersHref(nextTraits, activeTraitRanges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onApplyTraitRange(
		key: string,
		fromValue: string | null,
		toValue: string | null
	): Promise<void> {
		const nextRanges = setTraitRangeFilter(activeTraitRanges, key, fromValue, toValue);
		activeTraitRanges = nextRanges;
		await goto(buildFiltersHref(activeTraits, nextRanges), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onLoadPrevious(event: MouseEvent): Promise<void> {
		event.preventDefault();
		if (!paginationMetrics.hasPreviousPage || pagingPending) return;

		pagingPending = true;
		await goto(loadPreviousHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onLoadNext(event: MouseEvent): Promise<void> {
		event.preventDefault();
		if (!tailNextCursor || pagingPending) return;

		pagingPending = true;
		await goto(loadNextHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	function resolveAdjacentPreviewTokenId(step: -1 | 1, currentTokenId: string): string | null {
		const currentIndex = visibleTokens.findIndex((token) => token.tokenId === currentTokenId);
		if (currentIndex === -1) {
			return null;
		}
		return visibleTokens[currentIndex + step]?.tokenId ?? null;
	}

	function onGlobalKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
		if (event.defaultPrevented || $keyboardShortcutsHelpState.open) {
			return;
		}

		const previewWasOpen = $tokenPreviewState.open;
		tokenPreview.onWindowKeydown(event);
		if (previewWasOpen) {
			return;
		}

		if (collectionNavigation && handleCollectionSectionShortcut(event, collectionNavigation)) {
			return;
		}

		if (
			!event.defaultPrevented &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!isKeyboardTextEntryTarget(event.target)
		) {
			const key = event.key.toLowerCase();
			if (key === 'v') {
				const nextMode = nextPageMediaMode();
				if (nextMode) {
					event.preventDefault();
					void goto(mediaModeHref(nextMode), {
						invalidateAll: true,
						keepFocus: true,
						noScroll: true
					});
					return;
				}
			}
		}

		traitFacetPanel.onWindowKeydown(event, {
			onReset: onResetTraits
		});
	}

</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="detail-layout" class:sidebar-collapsed={$traitFacetPanelState.collapsed}>
	<TraitFacetPanel
		{facets}
		selectedTraits={activeTraits}
		selectedRanges={activeTraitRanges}
		collapsed={$traitFacetPanelState.collapsed}
		onToggleTrait={onTraitToggleWithMode}
		onApplyTraitRange={onApplyTraitRange}
	/>

	<div class="token-panel">
		<CursorPaginationControls
			resultsSummary={browserResultsSummary()}
			totalItems={tokens.totalItems}
			rangeStart={visibleRangeStart}
			rangeEnd={visibleRangeEnd}
			totalPages={tokens.totalPages}
			visibleStartPage={paginationMetrics.visibleStartPage}
			visibleEndPage={paginationMetrics.visibleEndPage}
			remainingItems={paginationMetrics.remainingItems}
			{pagesLoaded}
			hasPreviousPage={paginationMetrics.hasPreviousPage}
			previousHref={loadPreviousHref()}
			previousBusy={pagingPending}
			onPrevious={onLoadPrevious}
			hasNextPage={paginationMetrics.hasNextPage}
			nextHref={loadNextHref()}
			nextBusy={pagingPending}
			onNext={onLoadNext}
			endLabel="end of token results"
		>
			{#snippet actions()}
				{#if showDisplayModeControls}
					<div class="secondary-tabs" aria-label="Token display mode">
						{#if isGridMode}
							<span class="secondary-tab-active">grid</span>
						{:else}
							<a href={modeHref('grid')}>grid</a>
						{/if}
						{#if !isGridMode}
							<span class="secondary-tab-active">table</span>
						{:else}
							<a href={modeHref('table')}>table</a>
						{/if}
					</div>
				{/if}
				{#if hasMediaModeChoices}
					<div class="secondary-tabs" aria-label="Token media mode">
						{#each media.availableModes as mode}
							{#if mode.key === media.selectedMode}
								<span class="secondary-tab-active">{mode.label}</span>
							{:else}
								<a href={mediaModeHref(mode.key)}>{mode.label}</a>
							{/if}
						{/each}
					</div>
				{/if}
				{#if selection}
					<div class="secondary-tabs" aria-label="Token bidding selection">
						<button type="button" class="button-link" disabled={tokens.totalItems === 0} onclick={selection.onSelectAll}>
							select all tokens
						</button>
						{#if selection.summary}
							<span class="mono bidding-selection-summary">{selection.summary}</span>
							<button type="button" class="button-link" onclick={selection.onClear}>clear</button>
						{/if}
					</div>
				{/if}
			{/snippet}

			{#if isGridMode}
				<div class="token-grid-wrap">
					{#if visibleTokens.length === 0}
						<div class="empty-cell">{emptyMessage}</div>
					{:else}
						<div class="token-grid">
							{#each visibleTokens as token}
								<TokenCardTile
									{chain}
									{collection}
									{token}
									href={tokenDetailHref(token.tokenId)}
									selectedMediaMode={media.selectedMode}
									availableMediaModes={media.availableModes}
									{tokenPreview}
									adjacentTokenResolver={resolveAdjacentPreviewTokenId}
									marketPrices={tokenMarketPrices(token)}
									selection={selection
										? {
												state: selection.state(token.tokenId),
												onToggle: (request) =>
													selection.onToggle({
														...request,
														visibleTokenIds
													})
											}
										: null}
								/>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<div class="table-wrap">
					<table class="token-table">
						<thead>
							<tr>
								<th class="token-id-col">id</th>
								<th class="token-image-col">image</th>
								<th class="token-price-col">price</th>
								{#if traitColumns.length === 0}
									<th>traits</th>
								{:else}
									{#each traitColumns as traitKey}
										<th>{traitKey}</th>
									{/each}
								{/if}
							</tr>
						</thead>
						<tbody>
							{#if visibleTokens.length === 0}
								<tr>
									<td
										colspan={traitColumns.length === 0 ? 4 : 3 + traitColumns.length}
										class="empty-cell">{emptyMessage}</td
									>
								</tr>
							{:else}
								{#each visibleTokens as token}
									<tr>
										<td class="mono token-id-cell">
											<a class="token-table-id-link" href={tokenDetailHref(token.tokenId)}
												>{token.tokenId}</a
											>
										</td>
										<td class="token-image-cell">
											<TokenMediaPreviewTrigger
												chainRef={chain?.slug ?? null}
												collectionRef={collection?.slug ?? null}
												tokenId={token.tokenId}
												image={token.image}
												selectedMediaMode={media.selectedMode}
												availableMediaModes={media.availableModes}
												{tokenPreview}
												adjacentTokenResolver={resolveAdjacentPreviewTokenId}
												mode="inline"
												imageClass="token-thumb"
												emptyClass="token-thumb token-thumb-empty"
											/>
										</td>
										<td class="mono token-price-cell">
											{#if tokenListingLabel(token)}
												{#if openseaItemHref(token)}
													<a
														class="token-price-link"
														href={openseaItemHref(token)}
														target="_blank"
														rel="noreferrer noopener"
													>
														{tokenListingLabel(token)}
													</a>
												{:else}
													{tokenListingLabel(token)}
												{/if}
											{:else}
												<span class="muted">-</span>
											{/if}
										</td>
										{#if traitColumns.length === 0}
											<td class="mono">{tokenTraitsLabel(token)}</td>
										{:else}
											{#each traitColumns as traitKey}
												{@const value = tokenTraitValue(token, traitKey)}
												<td class="token-trait-cell">
													{#if value}
														<div class="mono token-trait-primary">{value}</div>
														{@const stats = traitStatsLabel(traitKey, value)}
														{#if stats}
															<div class="muted token-trait-meta">{stats}</div>
														{/if}
													{:else}
														<span class="muted">-</span>
													{/if}
												</td>
											{/each}
										{/if}
									</tr>
								{/each}
							{/if}
						</tbody>
					</table>
				</div>
			{/if}
		</CursorPaginationControls>
	</div>
</div>
