<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionHolder,
		ApiCollectionHoldersPage
	} from '$lib/api-types';
	import {
		incomingForwardWindowState,
		readForwardWindow,
		resolveForwardWindowState,
		writeForwardWindow
	} from '$lib/components/forward-window-cache';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import { appendMediaModeParam } from '$lib/media-mode';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import { buildOwnerTokensHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		holders,
		basePath,
		selectedMediaMode,
		requestCursor
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		holders: ApiCollectionHoldersPage;
		basePath: string;
		selectedMediaMode: string | null;
		requestCursor: string | null;
	} = $props();

	let visibleHolders = $state<ApiCollectionHolder[]>(holders.items);
	let visibleRangeStart = $state(holders.rangeStart);
	let visibleRangeEnd = $state(holders.rangeEnd);
	let pagesLoaded = $state(holders.items.length === 0 ? 0 : 1);
	let pagingPending = $state(false);
	let tailNextCursor = $state<string | null>(holders.nextCursor);
	let loadMoreSentinel: HTMLDivElement | null = $state(null);
	let hasNextPage = $derived(tailNextCursor !== null);
	let remainingItems = $derived(Math.max(holders.totalItems - visibleRangeEnd, 0));
	let visibleStartPage = $derived(
		visibleRangeStart === 0 ? 0 : Math.floor((visibleRangeStart - 1) / holders.limit) + 1
	);
	let visibleEndPage = $derived(
		visibleRangeEnd === 0 ? 0 : Math.floor((visibleRangeEnd - 1) / holders.limit) + 1
	);

	$effect(() => {
		const signature = holdersSignature(holders.limit);
		const incoming = incomingForwardWindowState(holders);
		const cached = browser ? readForwardWindow<ApiCollectionHolder>(signature) : null;
		const resolved = resolveForwardWindowState({
			cached,
			incoming,
			requestCursor,
			getItemKey: (holder) => holder.owner
		});

		visibleHolders = resolved.items;
		visibleRangeStart = resolved.rangeStart;
		visibleRangeEnd = resolved.rangeEnd;
		pagesLoaded = resolved.pagesLoaded;
		tailNextCursor = resolved.tailNextCursor;

		if (browser) {
			writeForwardWindow(signature, resolved);
		}

		pagingPending = false;
	});

	$effect(() => {
		if (!browser || !loadMoreSentinel || !hasNextPage) return;
		if (typeof IntersectionObserver === 'undefined') return;

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					void loadNextPage();
				}
			},
			{
				rootMargin: '0px 0px 320px 0px'
			}
		);

		observer.observe(loadMoreSentinel);
		return () => observer.disconnect();
	});

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function tokensHref(): string {
		if (!collection) return '#';
		const query = new URLSearchParams();
		appendMediaModeParam(query, selectedMediaMode);
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function holdersPath(): string {
		return `${basePath}/holders`;
	}

	function holdersHref(): string {
		if (!collection) return '#';
		const query = new URLSearchParams();
		appendMediaModeParam(query, selectedMediaMode);
		const suffix = query.toString();
		const path = holdersPath();
		return suffix ? `${path}?${suffix}` : path;
	}

	function holderHref(owner: string): string {
		return buildOwnerTokensHref({
			basePath: `${holdersPath()}/${encodeURIComponent(owner)}`,
			selectedTraits: [],
			mediaMode: selectedMediaMode
		});
	}

	function holdersSignature(limit: number): string {
		return `${holdersHref()}|${limit}`;
	}

	function loadNextHref(): string {
		if (!tailNextCursor) return '#';
		const query = new URLSearchParams();
		query.set('limit', String(holders.limit));
		query.set('cursor', tailNextCursor);
		appendMediaModeParam(query, selectedMediaMode);
		return `${holdersPath()}?${query.toString()}`;
	}

	function holdersResultsSummary(): string {
		return `${holders.totalItems} holder${holders.totalItems === 1 ? '' : 's'}`;
	}

	function formatHeldPercent(value: number | null): string {
		if (value === null || Number.isNaN(value)) {
			return 'n/a';
		}
		if (value > 0 && value < 0.001) {
			return '<0.001%';
		}
		if (value > 0 && value < 0.01) {
			return `${value.toFixed(3)}%`;
		}
		return `${value.toFixed(2)}%`;
	}

	function holderRowRank(index: number): number {
		if (visibleRangeStart <= 0) return index + 1;
		return visibleRangeStart + index;
	}

	async function loadNextPage(): Promise<void> {
		if (!tailNextCursor || pagingPending) return;

		pagingPending = true;
		await goto(loadNextHref(), {
			invalidateAll: true,
			keepFocus: true,
			noScroll: true
		});
	}

	async function onLoadNext(event: Event): Promise<void> {
		event.preventDefault();
		await loadNextPage();
	}
</script>

<CollectionPageLayout
	tokensHref={tokensHref()}
	activitiesHref={buildCollectionActivityHref({
		basePath,
		limit: holders.limit,
		kind: 'sales',
		selectedTraits: [],
		mediaMode: selectedMediaMode
	})}
	holdersHref={holdersHref()}
	activeSection="holders"
	collectionAvailable={collection !== null}
>
	{#snippet breadcrumbs()}
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<a href={tokensHref()}>{collection.slug}</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">holders</span>
		{/if}
	{/snippet}
	{#snippet topActions()}
		<div class="panel-top-actions-row">
			<span class="mono token-results-summary">{holdersResultsSummary()}</span>
		</div>
	{/snippet}

	<div class="table-wrap holders-table-wrap">
		<table class="holders-table">
			<thead>
				<tr>
					<th class="holder-position-col">position</th>
					<th class="holder-owner-col">holder</th>
					<th class="holder-count-col">held</th>
					<th class="holder-percent-col">% held</th>
				</tr>
			</thead>
			<tbody>
				{#if visibleHolders.length === 0}
					<tr>
						<td colspan="4" class="empty-cell">no holders found</td>
					</tr>
				{:else}
					{#each visibleHolders as holder, index (holder.owner)}
						<tr>
							<td class="mono holder-position-cell">{holderRowRank(index)}</td>
							<td class="mono holder-owner-cell">
								<a href={holderHref(holder.owner)}>{holder.owner}</a>
							</td>
							<td class="mono holder-count-cell">{holder.tokenCount}</td>
							<td class="mono holder-percent-cell">{formatHeldPercent(holder.heldPercent)}</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
	{#if hasNextPage}
		<div class="holders-load-more-sentinel" bind:this={loadMoreSentinel} aria-hidden="true"></div>
	{/if}

	<footer class="panel-footer holders-summary">
		<div class="pagination-summary">
			{#if holders.totalItems === 0}
				<span class="muted">showing 0 of 0</span>
			{:else}
				<span class="mono">showing {visibleRangeStart}-{visibleRangeEnd} of {holders.totalItems}</span>
				{#if visibleStartPage > 0 && visibleEndPage > 0}
					{#if visibleStartPage === visibleEndPage}
						<span class="muted">page {visibleStartPage} / {holders.totalPages}</span>
					{:else}
						<span class="muted">pages {visibleStartPage}-{visibleEndPage} / {holders.totalPages}</span>
					{/if}
				{/if}
				<span class="muted">{remainingItems} left</span>
				{#if pagesLoaded > 1}
					<span class="muted">loaded {pagesLoaded} pages</span>
				{/if}
			{/if}
		</div>
		{#if hasNextPage}
			{#if pagingPending}
				<span class="muted">loading more holders...</span>
			{:else}
				<a
					class="button-link"
					href={loadNextHref()}
					aria-busy={pagingPending}
					onclick={onLoadNext}>load next</a
				>
			{/if}
		{:else}
			<span class="muted">end of holder results</span>
		{/if}
	</footer>
</CollectionPageLayout>
