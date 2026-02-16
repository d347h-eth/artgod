<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenCard,
		ApiTokensPage,
		ApiTraitFacet,
		ApiTokenAttribute
	} from '$lib/api-types';
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
		basePath,
		requestCursor,
		displayMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		basePath: string;
		requestCursor: string | null;
		displayMode: 'grid' | 'table';
	} = $props();

	const TRAIT_COLUMN_PRIORITY = ['Mode', 'Zone', 'Biome', 'x', 'y', 'Level', 'Chroma', '???'];

	let activeTraits = $state<ApiTokenAttribute[]>(selectedTraits);
	let traitValueSearch = $state<Record<string, string>>({});
	let visibleTokens = $state<ApiTokenCard[]>(tokens.items);
	let visibleRangeStart = $state(tokens.rangeStart);
	let visibleRangeEnd = $state(tokens.rangeEnd);
	let pagesLoaded = $state(tokens.items.length === 0 ? 0 : 1);
	let pagingPending = $state(false);
	let traitsCollapsed = $state(false);
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
		const signature = filtersSignature(selectedTraits, tokens.limit, displayMode);
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
		return `${basePath}/${encodeURIComponent(tokenId)}`;
	}

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
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

	function visibleFacetValues(
		facet: ApiTraitFacet
	): Array<{ value: string; tokenCount: number }> {
		return facet.values.filter((item) => traitValueMatches(facet.key, item.value));
	}

	function buildFiltersHref(
		traits: ApiTokenAttribute[],
		cursor: string | null = null,
		mode: 'grid' | 'table' = displayMode
	): string {
		const query = new URLSearchParams();
		query.set('limit', String(tokens.limit));
		query.set('mode', mode);
		if (cursor) {
			query.set('cursor', cursor);
		}
		for (const trait of traits) {
			query.append('traits', `${trait.key}:${trait.value}`);
		}
		return `${basePath}?${query.toString()}`;
	}

	function filtersSignature(traits: ApiTokenAttribute[], limit: number, mode: 'grid' | 'table'): string {
		const normalized = traits
			.map((item) => `${item.key}:${item.value}`)
			.sort((a, b) => a.localeCompare(b));
		return `${basePath}|${limit}|${mode}|${normalized.join(',')}`;
	}

	function appendUniqueTokens(
		source: ApiTokenCard[],
		incoming: ApiTokenCard[]
	): ApiTokenCard[] {
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

	function prependUniqueTokens(
		source: ApiTokenCard[],
		incoming: ApiTokenCard[]
	): ApiTokenCard[] {
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

	function buildTraitFacetIndex(
		input: ApiTraitFacet[]
	): Map<string, Map<string, number>> {
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
		checked: boolean
	): ApiTokenAttribute[] {
		const grouped = new Map<string, Set<string>>();
		for (const trait of sourceTraits) {
			const set = grouped.get(trait.key) ?? new Set<string>();
			set.add(trait.value);
			grouped.set(trait.key, set);
		}

		const current = grouped.get(key) ?? new Set<string>();
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

		const next: ApiTokenAttribute[] = [];
		for (const [groupKey, values] of grouped.entries()) {
			const sortedValues = [...values].sort((a, b) => a.localeCompare(b));
			for (const traitValue of sortedValues) {
				next.push({ key: groupKey, value: traitValue });
			}
		}
		return next;
	}

	async function onTraitToggle(key: string, value: string, checked: boolean): Promise<void> {
		const nextTraits = nextSelectedTraits(activeTraits, key, value, checked);
		activeTraits = nextTraits;
		await goto(buildFiltersHref(nextTraits), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	function onTraitCheckboxChange(key: string, value: string, event: Event): void {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		void onTraitToggle(key, value, target.checked);
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
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		<a href="/">home</a>
		<span class="breadcrumbs-separator">/</span>
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">{collection.slug ?? collection.address}</span>
		{/if}
	</nav>

	<header class="panel-header">
		<div>
			<h1 class="panel-title">Collection Browser</h1>
			<p class="panel-subtitle">
				{#if chain && collection}
					{chain.slug} / {collection.slug ?? collection.address}
				{:else}
					collection not found
				{/if}
			</p>
		</div>
		<div class="meta-box">
			{#if collection}
				<div class="mono">address: {collection.address}</div>
				<div>status: {collection.status}</div>
			{/if}
		</div>
	</header>

	<div class="detail-layout" class:sidebar-collapsed={traitsCollapsed}>
		<div class="facet-column">
			<button
				class="facet-collapse-button"
				type="button"
				aria-expanded={!traitsCollapsed}
				aria-label={traitsCollapsed ? 'expand traits sidebar' : 'collapse traits sidebar'}
				onclick={onToggleTraitsSidebar}
			>
				{traitsCollapsed ? '>' : '<'}
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
									<span>{facet.key}</span>
									<span class="muted">{facet.values.length} values</span>
								</summary>

								<div class="trait-group-body">
									<input
										class="trait-search-input"
										type="search"
										placeholder="search values (*query*)"
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
														onchange={(event) =>
															onTraitCheckboxChange(facet.key, value.value, event)}
													/>
													<span class="trait-value-text">{value.value}</span>
													<span class="muted">({value.tokenCount})</span>
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
				<div>
					{#if hasPreviousPage}
						<a
							class="button-link"
							href={loadPreviousHref()}
							aria-busy={pagingPending}
							onclick={onLoadPrevious}>load previous</a
						>
					{/if}
				</div>
				<div class="mode-toggle">
					<button
						type="button"
						aria-label={`switch to ${nextDisplayMode} mode`}
						onclick={onToggleDisplayMode}>{nextDisplayMode}</button
					>
				</div>
			</div>

			{#if isGridMode}
				<div class="token-grid-wrap">
					{#if visibleTokens.length === 0}
						<div class="empty-cell">no tokens match current filters</div>
					{:else}
						<div class="token-grid">
							{#each visibleTokens as token}
								<article class="token-grid-card">
									<div class="token-grid-media">
										{#if token.image}
											<img
												class="token-grid-thumb"
												src={token.image}
												alt={`token ${token.tokenId}`}
												loading="lazy"
												decoding="async"
												referrerpolicy="no-referrer"
											/>
										{:else}
											<div class="token-grid-thumb token-thumb-empty">-</div>
										{/if}
									</div>
									<div class="token-grid-meta">
										<a class="mono token-grid-id" href={tokenDetailHref(token.tokenId)}>{token.tokenId}</a>
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
									<td colspan={traitColumns.length === 0 ? 3 : 2 + traitColumns.length} class="empty-cell"
										>no tokens match current filters</td
									>
								</tr>
							{:else}
								{#each visibleTokens as token}
									<tr>
										<td class="mono token-id-cell">{token.tokenId}</td>
										<td class="token-image-cell">
											{#if token.image}
												<img
													class="token-thumb"
													src={token.image}
													alt={`token ${token.tokenId}`}
													loading="lazy"
													decoding="async"
													referrerpolicy="no-referrer"
												/>
											{:else}
												<div class="token-thumb token-thumb-empty">-</div>
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
</section>
