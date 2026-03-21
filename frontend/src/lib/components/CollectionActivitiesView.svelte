<script lang="ts">
	import type {
		ApiActivitiesPage,
		ApiActivityFeedFilterKind,
		ApiActivityFeedItem,
		ApiChain,
		ApiCollection
	} from '$lib/api-types';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';

	let {
		chain,
		collection,
		activities,
		basePath,
		filterKind
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		activities: ApiActivitiesPage;
		basePath: string;
		filterKind: ApiActivityFeedFilterKind;
	} = $props();

	const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
	const WEI_BASE = 10n ** 18n;

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function tokensHref(): string {
		return collection ? basePath : '#';
	}

	function filterHref(nextKind: ApiActivityFeedFilterKind, cursor: string | null = null): string {
		const query = new URLSearchParams();
		query.set('limit', String(activities.limit));
		query.set('kind', nextKind);
		if (cursor) {
			query.set('cursor', cursor);
		}
		return `${basePath}/activity?${query.toString()}`;
	}

	function tokenHref(tokenId: string): string {
		return `${basePath}/${encodeURIComponent(tokenId)}`;
	}

	function paginationHref(cursor: string | null): string {
		return filterHref(filterKind, cursor);
	}

	function resultsSummary(): string {
		const count = activities.totalItems;
		if (filterKind === 'sales') {
			return `${count} sale${count === 1 ? '' : 's'}`;
		}
		if (filterKind === 'listings') {
			return `${count} listing event${count === 1 ? '' : 's'}`;
		}
		return `${count} transfer${count === 1 ? '' : 's'}`;
	}

	function activityTypeLabel(activity: ApiActivityFeedItem): string {
		switch (activity.kind) {
			case 'sale':
				return 'sale';
			case 'transfer':
				return 'transfer';
			case 'listing_created':
				return 'listing created';
			case 'listing_cancelled':
				return 'listing cancelled';
			default:
				return activity.kind.replace(/_/g, ' ');
		}
	}

	function tokenLabel(activity: ApiActivityFeedItem): string {
		return activity.tokenId ?? 'collection';
	}

	function occurredAtLabel(occurredAt: number): string {
		return new Date(occurredAt * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
	}

	function shortAddress(value: string | null): string | null {
		if (!value) return null;
		if (value.length <= 12) return value;
		return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

	function detailsLabel(activity: ApiActivityFeedItem): string {
		const formattedPrice = formatPrice(activity.price, activity.currency);
		switch (activity.kind) {
			case 'sale': {
				const from = shortAddress(activity.from);
				const to = shortAddress(activity.to);
				const transfer =
					from && to ? `${from} -> ${to}` : from ?? to ?? 'participants unavailable';
				return formattedPrice ? `${formattedPrice} | ${transfer}` : transfer;
			}
			case 'transfer': {
				const from = shortAddress(activity.from);
				const to = shortAddress(activity.to);
				return from && to ? `${from} -> ${to}` : from ?? to ?? '-';
			}
			case 'listing_created':
				return formattedPrice ? `listed at ${formattedPrice}` : 'listed';
			case 'listing_cancelled':
				return formattedPrice ? `cancelled at ${formattedPrice}` : 'cancelled';
			default:
				return formattedPrice ?? '-';
		}
	}
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<a href={tokensHref()}>{collection.slug}</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">activities</span>
		{/if}
	</nav>

	<header class="panel-header">
		{#if collection}
			<CollectionSectionTabs basePath={basePath} active="activities" />
		{:else}
			<span class="muted">collection not found</span>
		{/if}
	</header>

	<div class="panel-top-actions">
		<div class="runtime-tabs" aria-label="Activity type filters">
			{#if filterKind === 'sales'}
				<span class="runtime-tab-active">sales</span>
			{:else}
				<a href={filterHref('sales')}>sales</a>
			{/if}
			{#if filterKind === 'listings'}
				<span class="runtime-tab-active">listings</span>
			{:else}
				<a href={filterHref('listings')}>listings</a>
			{/if}
			{#if filterKind === 'transfers'}
				<span class="runtime-tab-active">transfers</span>
			{:else}
				<a href={filterHref('transfers')}>transfers</a>
			{/if}
		</div>
		<span class="mono token-results-summary">{resultsSummary()}</span>
	</div>

	<div class="table-wrap activities-table-wrap">
		<table class="activities-table">
			<thead>
				<tr>
					<th class="activities-time-col">time</th>
					<th class="activities-token-col">token</th>
					<th class="activities-kind-col">activity</th>
					<th class="activities-details-col">details</th>
				</tr>
			</thead>
			<tbody>
				{#if activities.items.length === 0}
					<tr>
						<td colspan="4" class="empty-cell">no activities found</td>
					</tr>
				{:else}
					{#each activities.items as activity (activity.id)}
						<tr>
							<td class="mono activities-time-cell">{occurredAtLabel(activity.occurredAt)}</td>
							<td class="mono activities-token-cell">
								{#if activity.tokenId}
									<a href={tokenHref(activity.tokenId)}>#{tokenLabel(activity)}</a>
								{:else}
									{tokenLabel(activity)}
								{/if}
							</td>
							<td class="activities-kind-cell">{activityTypeLabel(activity)}</td>
							<td class="mono activities-details-cell">{detailsLabel(activity)}</td>
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
</section>
