<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import type {
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTraitRangeFilter
	} from '$lib/api-types';
	import { buildCollectionActivityHref } from '$lib/activity-query';
	import { buildCollectionBiddingHref, buildCollectionBiddingQuery } from '$lib/bidding-query';
	import CollectionJumpForm from '$lib/components/CollectionJumpForm.svelte';
	import CollectionPageLayout from '$lib/components/CollectionPageLayout.svelte';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import CollectionBiddingJobRow from '$lib/components/CollectionBiddingJobRow.svelte';
	import { buildCollectionCustomizationHref } from '$lib/customization-query';
	import { appendMediaModeParam } from '$lib/media-mode';
	import { joinPath, withQuery } from '$lib/route-paths';
	import {
		IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		publicCollectionTokensPath
	} from '$lib/runtime/public-deployment';
	import { buildTokenBrowserHref } from '$lib/token-browser-query';

	let {
		chain,
		collection,
		jobs,
		basePath,
		selectedTraits,
		selectedTraitRanges,
		mediaMode
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		mediaMode: string | null;
	} = $props();

	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	let collectionJobs = $state<ApiBiddingJob[]>(jobs);

	const tokenJobCount = $derived(
		collectionJobs.filter((job) => job.target.type === 'token').length
	);
	const nonTokenJobCount = $derived(collectionJobs.length - tokenJobCount);

	$effect(() => {
		collectionJobs = jobs;
	});

	function collectionsHref(): string {
		if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return publicCollectionTokensPath();
		if (!chain) return '/';
		return `/${chain.slug}`;
	}

	function tokensHref(): string {
		return buildTokenBrowserHref({
			basePath,
			limit: DEFAULT_PAGE_LIMIT,
			displayMode: 'grid',
			tokenStatus: 'listed',
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function activitiesHref(): string {
		return buildCollectionActivityHref({
			basePath,
			limit: DEFAULT_PAGE_LIMIT,
			kind: 'sales',
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function holdersHref(): string {
		const query = new URLSearchParams();
		appendMediaModeParam(query, mediaMode);
		return withQuery(joinPath(basePath, 'holders'), query);
	}

	function customizationHref(): string {
		return buildCollectionCustomizationHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function biddingHref(): string {
		return buildCollectionBiddingHref({
			basePath,
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		});
	}

	function biddingPath(): string {
		return joinPath(basePath, 'bidding');
	}

	function biddingReturnQuery(): string {
		return buildCollectionBiddingQuery({
			selectedTraits,
			selectedTraitRanges,
			mediaMode
		}).toString();
	}

	function handleJobUpdated(nextJob: ApiBiddingJob): void {
		collectionJobs = collectionJobs.map((job) => (job.jobId === nextJob.jobId ? nextJob : job));
	}

	function handleJobArchived(jobId: string): void {
		collectionJobs = collectionJobs.filter((job) => job.jobId !== jobId);
	}
</script>

<CollectionPageLayout
	tokensHref={tokensHref()}
	activitiesHref={activitiesHref()}
	holdersHref={holdersHref()}
	customizationHref={customizationHref()}
	biddingHref={biddingHref()}
	activeSection="bidding"
	collectionAvailable={collection !== null}
	showCustomization={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
	showBidding={!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
>
	{#snippet breadcrumbs()}
		{#if collection}
			{#if IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT}
				<a href={tokensHref()}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">bidding</span>
			{:else}
				<a href={collectionsHref()}>collections</a>
				<span class="breadcrumbs-separator">/</span>
				<a href={tokensHref()}>{collection.slug}</a>
				<span class="breadcrumbs-separator">/</span>
				<span class="breadcrumbs-current">bidding</span>
			{/if}
		{/if}
	{/snippet}
	{#snippet headerActions()}
		{#if collection}
			<CollectionJumpForm chainRef={chain?.slug ?? ''} basePath={basePath} mediaMode={mediaMode} />
		{/if}
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} />
	{/snippet}

	<section class="runtime-section">
		<div class="runtime-kv-grid">
			<div>
				<span class="runtime-k">jobs</span>
				<span class="runtime-v">{collectionJobs.length}</span>
			</div>
			<div>
				<span class="runtime-k">token jobs</span>
				<span class="runtime-v">{tokenJobCount}</span>
			</div>
			<div>
				<span class="runtime-k">other scopes</span>
				<span class="runtime-v">{nonTokenJobCount}</span>
			</div>
		</div>
		<p class="muted">
			token-scoped jobs can be edited inline here. collection and competitive-trait rows stay
			read-only until their scoped CRUD lands.
		</p>
	</section>

	{#if collectionJobs.length === 0}
		<section class="runtime-section">
			<p class="muted">no bidding jobs declared for this collection yet</p>
		</section>
	{:else}
		<div class="table-wrap">
			<table class="bidding-jobs-table">
				<thead>
					<tr>
						<th>target</th>
						<th>status</th>
						<th>floor</th>
						<th>ceiling</th>
						<th>delta</th>
						<th>runtime</th>
						<th>actions</th>
					</tr>
				</thead>
				<tbody>
					{#each collectionJobs as job (job.jobId)}
						<CollectionBiddingJobRow
							chainRef={chain?.slug ?? ''}
							collectionRef={collection?.slug ?? ''}
							collectionBasePath={basePath}
							returnPath={biddingPath()}
							returnQuery={biddingReturnQuery()}
							{mediaMode}
							{job}
							onJobUpdated={handleJobUpdated}
							onJobArchived={handleJobArchived}
						/>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</CollectionPageLayout>
