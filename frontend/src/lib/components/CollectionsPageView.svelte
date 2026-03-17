<script lang="ts">
	import { goto } from '$app/navigation';
	import { getBootstrapStatus } from '$lib/backend-api';
	import type { ApiChain, ApiCollection, ApiCollectionsPage } from '$lib/api-types';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';

	let {
		chain,
		page,
		status,
		basePath
	}: {
		chain: ApiChain | null;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
	} = $props();

	const statusOptions = ['', 'bootstrapping', 'live', 'paused', 'disabled'];
	let latestRunHrefByCollection = $state<Record<string, string | null>>({});

	$effect(() => {
		if (!chain) {
			latestRunHrefByCollection = {};
			return;
		}
		const bootstrappingItems = page.items.filter((item) => item.status === 'bootstrapping');
		if (bootstrappingItems.length === 0) {
			latestRunHrefByCollection = {};
			return;
		}

		let cancelled = false;
		void (async () => {
			const entries = await Promise.all(
				bootstrappingItems.map(async (item) => {
					try {
						const response = await getBootstrapStatus(fetch, chain.slug, collectionRef(item));
						const href = response.latestRun
							? `/${chain.slug}/bootstrap-runs/${response.latestRun.runId}`
							: null;
						return [collectionKey(item), href] as const;
					} catch {
						return [collectionKey(item), null] as const;
					}
				})
			);
			if (cancelled) return;
			const next: Record<string, string | null> = {};
			for (const [key, href] of entries) {
				next[key] = href;
			}
			latestRunHrefByCollection = next;
		})();

		return () => {
			cancelled = true;
		};
	});

	function collectionKey(collection: ApiCollection): string {
		return `${collection.chainId}:${collection.collectionId}`;
	}

	function collectionRef(collection: ApiCollection): string {
		return collection.slug;
	}

	function collectionHref(collection: ApiCollection): string {
		if (!chain) return '#';
		return `/${chain.slug}/${collectionRef(collection)}`;
	}

	function loadMoreHref(): string {
		if (!page.nextCursor) return '#';
		const query = new URLSearchParams();
		if (status) query.set('status', status);
		query.set('limit', String(page.limit));
		query.set('cursor', page.nextCursor);
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function applyStatusFilter(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		const query = new URLSearchParams();
		const nextStatus = target.value.trim();
		if (nextStatus) query.set('status', nextStatus);
		query.set('limit', String(page.limit));
		const suffix = query.toString();
		void goto(suffix ? `${basePath}?${suffix}` : basePath);
	}
</script>

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={chain?.slug ?? null} active="collections" />

	<header class="panel-header">
		<div>
			<p class="panel-subtitle">
				{#if chain}
					{chain.name} ({chain.slug} / {chain.publicChainId})
				{:else}
					Loading default chain...
				{/if}
			</p>
		</div>
		<div class="status-form">
			<label for="collection-status">status</label>
			<select id="collection-status" name="status" onchange={applyStatusFilter}>
				{#each statusOptions as option}
					<option value={option} selected={option === status}>{option || 'all'}</option>
				{/each}
			</select>
		</div>
	</header>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>slug</th>
					<th>address</th>
					<th>status</th>
				</tr>
			</thead>
			<tbody>
				{#if page.items.length === 0}
					<tr>
						<td colspan="3" class="empty-cell">no collections found</td>
					</tr>
				{:else}
					{#each page.items as collection}
						<tr>
							<td>
								<a href={collectionHref(collection)}>{collection.slug}</a>
							</td>
							<td class="mono">{collection.address}</td>
							<td>
								{#if collection.status === 'bootstrapping' && latestRunHrefByCollection[collectionKey(collection)]}
									<a href={latestRunHrefByCollection[collectionKey(collection)] ?? '#'}>
										{collection.status}
									</a>
								{:else}
									{collection.status}
								{/if}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<footer class="panel-footer">
		{#if page.nextCursor}
			<a class="button-link" href={loadMoreHref()}>load more</a>
		{:else}
			<span class="muted">end of results</span>
		{/if}
	</footer>
</section>
