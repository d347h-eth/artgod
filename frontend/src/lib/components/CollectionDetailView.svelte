<script lang="ts">
	import { browser } from '$app/environment';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		BootstrapStatusApiResponse,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';
	import { getBootstrapStatus } from '$lib/backend-api';
	import CollectionSectionTabs from '$lib/components/CollectionSectionTabs.svelte';
	import TokenStatusTabs from '$lib/components/TokenStatusTabs.svelte';
	import TokenBrowserView from '$lib/components/TokenBrowserView.svelte';

	let {
		chain,
		collection,
		tokens,
		facets,
		selectedTraits,
		basePath,
		requestCursor,
		tokenStatus,
		displayMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		basePath: string;
		requestCursor: string | null;
		tokenStatus: 'listed' | 'all';
		displayMode: 'grid' | 'table';
	} = $props();

	const BOOTSTRAP_POLL_INTERVAL_MS = 5_000;

	let bootstrapStatus = $state<BootstrapStatusApiResponse | null>(null);
	let bootstrapLoading = $state(false);
	let bootstrapError = $state<string | null>(null);
	let bootstrapRequestInFlight = false;

	$effect(() => {
		if (!browser || !chain || !collection || collection.status === 'live') {
			bootstrapStatus = null;
			bootstrapError = null;
			return;
		}
		void refreshBootstrapStatus();
		const timer = setInterval(() => {
			void refreshBootstrapStatus();
		}, BOOTSTRAP_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	function collectionsHref(): string {
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function activeCollectionRef(): string | null {
		if (!collection) return null;
		return collection.slug;
	}

	function latestRunHref(): string | null {
		if (!chain || !bootstrapStatus?.latestRun) return null;
		return `/${chain.slug}/bootstrap-runs/${bootstrapStatus.latestRun.runId}`;
	}

	async function refreshBootstrapStatus(): Promise<void> {
		if (!chain || !collection) return;
		if (bootstrapRequestInFlight) return;
		bootstrapRequestInFlight = true;
		bootstrapLoading = true;
		bootstrapError = null;
		try {
			const collectionRef = activeCollectionRef();
			if (!collectionRef) return;
			const response = await getBootstrapStatus(fetch, chain.slug, collectionRef);
			bootstrapStatus = response;
		} catch (error) {
			bootstrapError = error instanceof Error ? error.message : 'bootstrap status request failed';
		} finally {
			bootstrapLoading = false;
			bootstrapRequestInFlight = false;
		}
	}
</script>

<section class="panel">
	<nav class="breadcrumbs" aria-label="Breadcrumb">
		<a href={collectionsHref()}>collections</a>
		{#if collection}
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">{collection.slug}</span>
		{/if}
	</nav>

	<header class="panel-header">
		{#if collection}
			<CollectionSectionTabs basePath={basePath} active="tokens" />
		{:else}
			<span class="muted">collection not found</span>
		{/if}
	</header>

	{#if collection}
		<div class="panel-top-actions">
			<TokenStatusTabs
				basePath={basePath}
				limit={tokens.limit}
				{displayMode}
				{tokenStatus}
				{selectedTraits}
			/>
		</div>
	{/if}

	{#if collection && collection.status !== 'live'}
		<section class="panel-header">
			<span class="muted">collection status is {collection.status}</span>
			{#if latestRunHref()}
				<a class="button-link" href={latestRunHref() ?? '#'}>latest bootstrap run</a>
			{/if}
			{#if bootstrapLoading}
				<span class="muted">refreshing bootstrap status...</span>
			{/if}
			{#if bootstrapError}
				<span class="muted">{bootstrapError}</span>
			{/if}
		</section>
	{/if}

	<TokenBrowserView
		chain={chain}
		collection={collection}
		tokens={tokens}
		facets={facets}
		selectedTraits={selectedTraits}
		collectionBasePath={basePath}
		browserBasePath={basePath}
		requestCursor={requestCursor}
		tokenStatus={tokenStatus}
		displayMode={displayMode}
	/>
</section>
