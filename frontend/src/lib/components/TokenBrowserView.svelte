<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTokenCard,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
import TokenMediaPreviewTrigger from '$lib/components/TokenMediaPreviewTrigger.svelte';
import TokenPreviewOverlay from '$lib/components/TokenPreviewOverlay.svelte';
import { openseaItemHref as buildOpenseaItemHref } from '$lib/marketplace-links';
import { buildTokenBrowserHref } from '$lib/token-browser-query';
import { createTokenPreviewController } from '$lib/components/token-preview-controller';
	import {
		readTokenWindow,
		type TokenWindowState,
		writeTokenWindow
	} from '$lib/components/token-window-cache';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		collectionBasePath,
		browserBasePath,
		requestCursor,
		tokenStatus,
		displayMode,
		emptyMessage = 'no tokens match current filters'
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		collectionBasePath: string;
		browserBasePath: string;
		requestCursor: string | null;
		tokenStatus: 'listed' | 'all' | 'listed_then_unlisted';
		displayMode: 'grid' | 'table';
		emptyMessage?: string;
	} = $props();

	const TRAIT_COLUMN_PRIORITY = ['Mode', 'Zone', 'Biome', 'x', 'y', 'Level', 'Chroma', '???'];
	const TRAITS_COLLAPSED_STORAGE_KEY = 'artgod.tokenBrowser.traitsCollapsed';
	const TRAITS_COLLAPSED_ROOT_CLASS = 'token-browser-traits-collapsed';
	const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
	const WEI_BASE = 10n ** 18n;
	const tokenPreview = createTokenPreviewController(fetch);
	const tokenPreviewState = tokenPreview.state;

	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let traitValueSearch = $state<Record<string, string>>({});
	let visibleTokens = $state<ApiTokenCard[]>(tokens.items);
	let visibleRangeStart = $state(tokens.rangeStart);
	let visibleRangeEnd = $state(tokens.rangeEnd);
	let pagesLoaded = $state(tokens.items.length === 0 ? 0 : 1);
	let pagingPending = $state(false);
	let traitsCollapsed = $state(readInitialTraitsCollapsed());
	let headPrevCursor = $state<string | null>(tokens.prevCursor);
	let tailNextCursor = $state<string | null>(tokens.nextCursor);
	let activeTraitSet = $derived(new Set(activeTraits.map((item) => `${item.key}:${item.value}`)));
	let hasActiveFilters = $derived(activeTraits.length > 0);
	let remainingItems = $derived(Math.max(tokens.totalItems - visibleRangeEnd, 0));
	let hasPreviousPage = $derived(visibleRangeStart > 1);
	let hasNextPage = $derived(tailNextCursor !== null);
	let visibleStartPage = $derived(
		visibleRangeStart === 0 ? 0 : Math.floor((visibleRangeStart - 1) / tokens.limit) + 1
	);
	let visibleEndPage = $derived(
		visibleRangeEnd === 0 ? 0 : Math.floor((visibleRangeEnd - 1) / tokens.limit) + 1
	);
	let isGridMode = $derived(displayMode === 'grid');
	let nextDisplayMode = $derived<'grid' | 'table'>(isGridMode ? 'table' : 'grid');
	let traitColumns = $derived(resolveTraitColumns(facets));
	let traitFacetIndex = $derived(buildTraitFacetIndex(facets));

	$effect(() => {
		activeTraits = selectedTraits;
	});

	$effect(() => {
		const signature = filtersSignature(selectedTraits, tokens.limit, displayMode, tokenStatus);
		const incoming = incomingWindowState(tokens);
		const cached = browser ? readTokenWindow(signature) : null;
		const resolved = resolveWindowState({
			cached,
			incoming,
			requestCursor
		});

		visibleTokens = resolved.items;
		visibleRangeStart = resolved.rangeStart;
		visibleRangeEnd = resolved.rangeEnd;
		pagesLoaded = resolved.pagesLoaded;
		headPrevCursor = resolved.headPrevCursor;
		tailNextCursor = resolved.tailNextCursor;

		if (browser) {
			writeTokenWindow(signature, resolved);
		}

		pagingPending = false;
	});

	$effect(() => {
		if (!browser) return;
		try {
			window.localStorage.setItem(TRAITS_COLLAPSED_STORAGE_KEY, traitsCollapsed ? '1' : '0');
		} catch {
			// Ignore storage failures and keep the in-memory state.
		}
		document.documentElement.classList.toggle(TRAITS_COLLAPSED_ROOT_CLASS, traitsCollapsed);
	});

	function readInitialTraitsCollapsed(): boolean {
		if (!browser) return false;
		try {
			if (document.documentElement.classList.contains(TRAITS_COLLAPSED_ROOT_CLASS)) {
				return true;
			}
			return window.localStorage.getItem(TRAITS_COLLAPSED_STORAGE_KEY) === '1';
		} catch {
			return false;
		}
	}

	function traitId(key: string, value: string): string {
		return `${key}-${value}`.replace(/\s+/g, '-').toLowerCase();
	}

	function traitChecked(key: string, value: string): boolean {
		return activeTraitSet.has(`${key}:${value}`);
	}

	function loadPreviousHref(): string {
		if (!hasPreviousPage) return '#';
		return buildFiltersHref(activeTraits, headPrevCursor);
	}

	function loadNextHref(): string {
		if (!tailNextCursor) return '#';
		return buildFiltersHref(activeTraits, tailNextCursor);
	}

	function tokenDetailHref(tokenId: string): string {
		const query = new URLSearchParams();
		query.set('returnPath', browserBasePath);
		query.set('returnQuery', buildReturnQuery());
		const suffix = query.toString();
		return `${collectionBasePath}/${encodeURIComponent(tokenId)}${suffix ? `?${suffix}` : ''}`;
	}

	function buildReturnQuery(): string {
		const query = new URLSearchParams();
		query.set('limit', String(tokens.limit));
		query.set('mode', displayMode);
		query.set('token_status', tokenStatus);
		if (requestCursor) {
			query.set('cursor', requestCursor);
		}
		for (const trait of activeTraits) {
			query.append('traits', `${trait.key}:${trait.value}`);
		}
		return query.toString();
	}

	function tokenTraitsLabel(token: ApiTokenCard): string {
		if (token.attributes.length === 0) return 'no traits';
		return token.attributes.map((item) => `${item.key}:${item.value}`).join(' | ');
	}

	function tokenTraitLines(token: ApiTokenCard): string[] {
		const values = token.attributes
			.map((item) => item.value.trim())
			.filter((value) => value.length > 0);
		if (values.length === 0) return ['no traits'];

		const lines: string[] = [];
		for (let index = 0; index < values.length; index += 3) {
			lines.push(values.slice(index, index + 3).join(' / '));
		}
		return lines;
	}

	function listingCurrencyLabel(currency: string | null): string | null {
		if (!currency) return null;
		return currency.toLowerCase() === ZERO_ADDRESS ? 'ETH' : 'WETH';
	}

	function formatListingPrice(rawPrice: string | null, currency: string | null): string | null {
		if (!rawPrice || !currency || !/^\d+$/.test(rawPrice)) return null;
		const value = BigInt(rawPrice);
		const whole = value / WEI_BASE;
		const fraction = value % WEI_BASE;
		const fractionText = fraction.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
		const amount = fractionText ? `${whole}.${fractionText}` : `${whole}`;
		return `${amount} ${listingCurrencyLabel(currency)}`;
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

	function onTraitSearchInput(key: string, event: Event): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;

		traitValueSearch = {
			...traitValueSearch,
			[key]: target.value
		};
	}

	function traitSearchValue(key: string): string {
		return traitValueSearch[key] ?? '';
	}

	function traitValueMatches(key: string, value: string): boolean {
		const pattern = traitSearchValue(key).trim().toLowerCase();
		if (!pattern) return true;

		const haystack = value.toLowerCase();
		if (!pattern.includes('*')) {
			return haystack.includes(pattern);
		}

		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
		return new RegExp(`^${escaped}$`).test(haystack);
	}

	function visibleFacetValues(facet: ApiTraitFacet): Array<{ value: string; tokenCount: number }> {
		return facet.values.filter((item) => traitValueMatches(facet.key, item.value));
	}

	function buildFiltersHref(
		traits: ApiTokenAttribute[],
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
			cursor
		});
	}

	function filtersSignature(
		traits: ApiTokenAttribute[],
		limit: number,
		mode: 'grid' | 'table',
		activeTokenStatus: 'listed' | 'all' | 'listed_then_unlisted'
	): string {
		const normalized = traits
			.map((item) => `${item.key}:${item.value}`)
			.sort((a, b) => a.localeCompare(b));
		return `${browserBasePath}|${limit}|${mode}|${activeTokenStatus}|${normalized.join(',')}`;
	}

	function appendUniqueTokens(source: ApiTokenCard[], incoming: ApiTokenCard[]): ApiTokenCard[] {
		if (incoming.length === 0) return source;
		const seen = new Set(source.map((item) => item.tokenId));
		const merged = [...source];
		for (const token of incoming) {
			if (seen.has(token.tokenId)) continue;
			seen.add(token.tokenId);
			merged.push(token);
		}
		return merged;
	}

	function prependUniqueTokens(source: ApiTokenCard[], incoming: ApiTokenCard[]): ApiTokenCard[] {
		if (incoming.length === 0) return source;
		const seen = new Set<string>();
		const merged: ApiTokenCard[] = [];
		for (const token of [...incoming, ...source]) {
			if (seen.has(token.tokenId)) continue;
			seen.add(token.tokenId);
			merged.push(token);
		}
		return merged;
	}

	function incomingWindowState(page: ApiTokensPage): TokenWindowState {
		return {
			items: page.items,
			rangeStart: page.rangeStart,
			rangeEnd: page.rangeEnd,
			pagesLoaded: page.items.length === 0 ? 0 : 1,
			headPrevCursor: page.prevCursor,
			tailNextCursor: page.nextCursor
		};
	}

	function resolveWindowState(params: {
		cached: TokenWindowState | null;
		incoming: TokenWindowState;
		requestCursor: string | null;
	}): TokenWindowState {
		const { cached, incoming, requestCursor } = params;
		if (!cached) return incoming;

		const isAppend =
			requestCursor !== null &&
			cached.tailNextCursor !== null &&
			requestCursor === cached.tailNextCursor;

		const isPrependByCursor =
			requestCursor !== null &&
			cached.headPrevCursor !== null &&
			requestCursor === cached.headPrevCursor;

		const isPrependFirstPage =
			requestCursor === null &&
			cached.rangeStart > 1 &&
			incoming.rangeStart === 1 &&
			incoming.rangeEnd > 0 &&
			incoming.rangeEnd < cached.rangeStart;

		if (isAppend) {
			return {
				items: appendUniqueTokens(cached.items, incoming.items),
				rangeStart: cached.rangeStart || incoming.rangeStart,
				rangeEnd: Math.max(cached.rangeEnd, incoming.rangeEnd),
				pagesLoaded: cached.pagesLoaded + (incoming.items.length === 0 ? 0 : 1),
				headPrevCursor: cached.headPrevCursor ?? incoming.headPrevCursor,
				tailNextCursor: incoming.tailNextCursor
			};
		}

		if (isPrependByCursor || isPrependFirstPage) {
			return {
				items: prependUniqueTokens(cached.items, incoming.items),
				rangeStart:
					cached.rangeStart === 0
						? incoming.rangeStart
						: incoming.rangeStart > 0
							? Math.min(cached.rangeStart, incoming.rangeStart)
							: cached.rangeStart,
				rangeEnd: Math.max(cached.rangeEnd, incoming.rangeEnd),
				pagesLoaded: cached.pagesLoaded + (incoming.items.length === 0 ? 0 : 1),
				headPrevCursor: incoming.headPrevCursor,
				tailNextCursor: cached.tailNextCursor
			};
		}

		return incoming;
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
		return buildFiltersHref(activeTraits, requestCursor, mode);
	}

	function nextSelectedTraits(
		sourceTraits: ApiTokenAttribute[],
		key: string,
		value: string,
		checked: boolean,
		unionMode: boolean
	): ApiTokenAttribute[] {
		const grouped = new Map<string, Set<string>>();
		for (const trait of sourceTraits) {
			const set = grouped.get(trait.key) ?? new Set<string>();
			set.add(trait.value);
			grouped.set(trait.key, set);
		}

		const current = grouped.get(key) ?? new Set<string>();
		if (unionMode) {
			if (checked) {
				current.add(value);
			} else {
				current.delete(value);
			}
			if (current.size === 0) {
				grouped.delete(key);
			} else {
				grouped.set(key, current);
			}
		} else {
			if (checked) {
				grouped.set(key, new Set([value]));
			} else {
				grouped.delete(key);
			}
		}

		const next: ApiTokenAttribute[] = [];
		for (const [groupKey, values] of grouped.entries()) {
			const sortedValues = [...values].sort((a, b) => a.localeCompare(b));
			for (const traitValue of sortedValues) {
				next.push({ key: groupKey, value: traitValue });
			}
		}
		return next;
	}

	async function onTraitToggleWithMode(
		key: string,
		value: string,
		checked: boolean,
		unionMode: boolean
	): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked, unionMode);
		activeTraits = nextTraits;
		await goto(buildFiltersHref(nextTraits), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	function onTraitCheckboxClick(key: string, value: string, event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		void onTraitToggleWithMode(key, value, target.checked, event.ctrlKey);
	}

	function traitGroupActive(key: string): boolean {
		return activeTraits.some((item) => item.key === key);
	}

	function resetHref(): string {
		return buildFiltersHref([], null, displayMode);
	}

	async function onResetFilters(): Promise<void> {
		activeTraits = [];
		await goto(resetHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onLoadPrevious(event: Event): Promise<void> {
		event.preventDefault();
		if (!hasPreviousPage || pagingPending) return;

		pagingPending = true;
		await goto(loadPreviousHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onLoadNext(event: Event): Promise<void> {
		event.preventDefault();
		if (!tailNextCursor || pagingPending) return;

		pagingPending = true;
		await goto(loadNextHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onToggleDisplayMode(): Promise<void> {
		await goto(modeHref(nextDisplayMode), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	function onToggleTraitsSidebar(): void {
		traitsCollapsed = !traitsCollapsed;
	}

	function onGlobalKeydown(event: KeyboardEvent): void {
		const previewWasOpen = $tokenPreviewState.open;
		tokenPreview.onWindowKeydown(event);
		if (previewWasOpen) {
			return;
		}

		if (event.defaultPrevented) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key.toLowerCase() !== 't') return;
		if (isTypingTarget(event.target)) return;
		event.preventDefault();
		onToggleTraitsSidebar();
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName.toLowerCase();
		return tag === 'input' || tag === 'textarea' || tag === 'select';
	}

</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="detail-layout" class:sidebar-collapsed={traitsCollapsed}>
	<div class="facet-column" class:facet-column-sticky={!traitsCollapsed}>
		<button
			class="facet-collapse-button"
			type="button"
			aria-expanded={!traitsCollapsed}
			aria-label={traitsCollapsed ? 'expand traits sidebar' : 'collapse traits sidebar'}
			onclick={onToggleTraitsSidebar}
		>
			{traitsCollapsed ? '>' : 'T'}
		</button>

		{#if !traitsCollapsed}
			<aside class="facet-panel">
				<div class="facet-header">
					<h2>traits</h2>
					{#if hasActiveFilters}
						<button class="facet-reset-button" type="button" onclick={onResetFilters}>reset</button>
					{/if}
				</div>

				{#if facets.length === 0}
					<p class="muted">no trait facets yet</p>
				{:else}
					{#each facets as facet}
						<details class="trait-group">
							<summary>
								<span class:trait-group-active={traitGroupActive(facet.key)}>{facet.key}</span>
								<span class="muted">{facet.values.length}</span>
							</summary>

							<div class="trait-group-body">
								<input
									class="trait-search-input"
									type="search"
									placeholder="search"
									value={traitSearchValue(facet.key)}
									oninput={(event) => onTraitSearchInput(facet.key, event)}
								/>

								<div class="trait-values">
									{#if visibleFacetValues(facet).length === 0}
										<p class="muted">no matches</p>
									{:else}
										{#each visibleFacetValues(facet) as value}
											<label for={traitId(facet.key, value.value)}>
												<input
													id={traitId(facet.key, value.value)}
													type="checkbox"
													checked={traitChecked(facet.key, value.value)}
													onclick={(event) =>
														onTraitCheckboxClick(facet.key, value.value, event)}
												/>
												<span class="trait-value-text">{value.value}</span>
												<span class="trait-value-count mono">{value.tokenCount}</span>
											</label>
										{/each}
									{/if}
								</div>
							</div>
						</details>
					{/each}
				{/if}
			</aside>
		{/if}
	</div>

	<div class="token-panel">
		<div class="panel-top-actions">
			<span class="mono token-results-summary">{browserResultsSummary()}</span>
			{#if hasPreviousPage}
				<a
					class="button-link"
					href={loadPreviousHref()}
					aria-busy={pagingPending}
					onclick={onLoadPrevious}>load previous</a
				>
			{/if}
			<div class="mode-toggle">
				<button
					type="button"
					class="mode-toggle-button"
					aria-label={`switch to ${nextDisplayMode} mode`}
					onclick={onToggleDisplayMode}>{nextDisplayMode}</button
				>
			</div>
		</div>

		{#if isGridMode}
			<div class="token-grid-wrap">
				{#if visibleTokens.length === 0}
					<div class="empty-cell">{emptyMessage}</div>
				{:else}
						<div class="token-grid">
							{#each visibleTokens as token}
								<article class="token-grid-card">
									<TokenMediaPreviewTrigger
										chainRef={chain?.slug ?? null}
										collectionRef={collection?.slug ?? null}
										tokenId={token.tokenId}
										image={token.image}
										{tokenPreview}
										mode="grid"
										containerClass="token-grid-media"
										imageClass="token-grid-thumb"
										emptyClass="token-grid-thumb token-grid-thumb-empty token-thumb-empty"
									/>
									<div class="token-grid-meta">
										<a class="mono token-grid-id" href={tokenDetailHref(token.tokenId)}>{token.tokenId}</a>
									{#if tokenListingLabel(token)}
										<div class="mono token-grid-price">
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
										</div>
									{/if}
									{#each tokenTraitLines(token) as line}
										<div class="mono token-grid-traits">{line}</div>
									{/each}
								</div>
							</article>
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
								<td colspan={traitColumns.length === 0 ? 4 : 3 + traitColumns.length} class="empty-cell"
									>{emptyMessage}</td
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
											{tokenPreview}
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

		<footer class="panel-footer">
			<div class="pagination-summary">
				{#if tokens.totalItems === 0}
					<span class="muted">showing 0 of 0</span>
				{:else}
					<span class="mono">showing {visibleRangeStart}-{visibleRangeEnd} of {tokens.totalItems}</span>
					{#if visibleStartPage > 0 && visibleEndPage > 0}
						{#if visibleStartPage === visibleEndPage}
							<span class="muted">page {visibleStartPage} / {tokens.totalPages}</span>
						{:else}
							<span class="muted">pages {visibleStartPage}-{visibleEndPage} / {tokens.totalPages}</span>
						{/if}
					{/if}
					<span class="muted">{remainingItems} left</span>
					{#if pagesLoaded > 1}
						<span class="muted">loaded {pagesLoaded} pages</span>
					{/if}
				{/if}
			</div>
			{#if hasNextPage}
				<a
					class="button-link"
					href={loadNextHref()}
					aria-busy={pagingPending}
					onclick={onLoadNext}>load next</a
				>
			{:else}
				<span class="muted">end of token results</span>
			{/if}
		</footer>
	</div>
</div>

<TokenPreviewOverlay
	state={$tokenPreviewState}
	closeTokenPreview={tokenPreview.closeTokenPreview}
/>
