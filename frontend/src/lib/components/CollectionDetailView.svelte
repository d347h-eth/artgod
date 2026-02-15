<script lang="ts">
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenCard,
		ApiTokensPage,
		ApiTraitFacet,
		ApiTokenAttribute
	} from '$lib/api-types';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		basePath
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		basePath: string;
	} = $props();

	const selectedSet = new Set(selectedTraits.map((item) => `${item.key}:${item.value}`));

	function traitId(key: string, value: string): string {
		return `${key}-${value}`.replace(/\s+/g, '-').toLowerCase();
	}

	function traitChecked(key: string, value: string): boolean {
		return selectedSet.has(`${key}:${value}`);
	}

	function loadMoreHref(): string {
		if (!tokens.nextCursor) return '#';
		const query = new URLSearchParams();
		query.set('limit', String(tokens.limit));
		query.set('cursor', tokens.nextCursor);
		for (const trait of selectedTraits) {
			query.append('traits', `${trait.key}:${trait.value}`);
		}
		return `${basePath}?${query.toString()}`;
	}

	function tokenTraitsLabel(token: ApiTokenCard): string {
		if (token.attributes.length === 0) return 'no traits';
		return token.attributes.slice(0, 4).map((item) => `${item.key}:${item.value}`).join(' | ');
	}
</script>

<section class="panel">
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

	<div class="detail-layout">
		<aside class="facet-panel">
			<h2>traits (AND)</h2>
			<form method="GET" action={basePath}>
				<input type="hidden" name="limit" value={tokens.limit} />
				{#if facets.length === 0}
					<p class="muted">no trait facets yet</p>
				{:else}
					{#each facets as facet}
						<fieldset>
							<legend>{facet.key}</legend>
							{#each facet.values as value}
								<label for={traitId(facet.key, value.value)}>
									<input
										id={traitId(facet.key, value.value)}
										type="checkbox"
										name="traits"
										value={`${facet.key}:${value.value}`}
										checked={traitChecked(facet.key, value.value)}
									/>
									<span>{value.value}</span>
									<span class="muted">({value.tokenCount})</span>
								</label>
							{/each}
						</fieldset>
					{/each}
				{/if}
				<div class="actions">
					<button type="submit">apply filters</button>
					<a href={basePath}>reset</a>
				</div>
			</form>
		</aside>

		<div class="token-panel">
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>token</th>
							<th>name</th>
							<th>traits</th>
							<th>image</th>
						</tr>
					</thead>
					<tbody>
						{#if tokens.items.length === 0}
							<tr>
								<td colspan="4" class="empty-cell">no tokens match current filters</td>
							</tr>
						{:else}
							{#each tokens.items as token}
								<tr>
									<td class="mono">{token.tokenId}</td>
									<td>{token.name ?? '-'}</td>
									<td class="mono">{tokenTraitsLabel(token)}</td>
									<td>{token.image ? 'yes' : 'no'}</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>

			<footer class="panel-footer">
				{#if tokens.nextCursor}
					<a class="button-link" href={loadMoreHref()}>load more</a>
				{:else}
					<span class="muted">end of token results</span>
				{/if}
			</footer>
		</div>
	</div>
</section>
