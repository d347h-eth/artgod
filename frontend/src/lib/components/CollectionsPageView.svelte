<script lang="ts">
	import type { ApiChain, ApiCollection, ApiCollectionsPage } from '$lib/api-types';

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

	function collectionRef(collection: ApiCollection): string {
		return collection.slug ?? collection.address;
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
</script>

<section class="panel">
	<header class="panel-header">
		<div>
			<h1 class="panel-title">ArtGod Collections</h1>
			<p class="panel-subtitle">
				{#if chain}
					{chain.name} ({chain.slug} / {chain.publicChainId})
				{:else}
					Loading default chain...
				{/if}
			</p>
		</div>
		<form class="status-form" method="GET" action={basePath}>
			<label for="status">status</label>
			<select id="status" name="status">
				{#each statusOptions as option}
					<option value={option} selected={option === status}>{option || 'all'}</option>
				{/each}
			</select>
			<button type="submit">apply</button>
		</form>
	</header>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>slug</th>
					<th>address</th>
					<th>status</th>
					<th>standard</th>
					<th>created</th>
				</tr>
			</thead>
			<tbody>
				{#if page.items.length === 0}
					<tr>
						<td colspan="5" class="empty-cell">no collections found</td>
					</tr>
				{:else}
					{#each page.items as collection}
						<tr>
							<td>
								<a href={collectionHref(collection)}>{collection.slug ?? '(no-slug)'}</a>
							</td>
							<td class="mono">{collection.address}</td>
							<td>{collection.status}</td>
							<td>{collection.standard}</td>
							<td class="mono">{collection.createdAt}</td>
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
