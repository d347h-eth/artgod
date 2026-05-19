<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import {
		SYNC_BACKFILL_CONTEXT_ANY,
		SYNC_BACKFILL_GRID_CELL_COUNT,
		SYNC_BACKFILL_GRID_DIMENSION
	} from '@artgod/shared/config/sync-backfill';
	import type {
		ApiSyncBackfillGridCell,
		ApiSyncBackfillRangeSummary,
		SyncBackfillRangeSummaryApiResponse,
		SyncBackfillStateApiResponse
	} from '$lib/api-types';
	import { getSyncBackfillRangeSummary, scheduleSyncBackfill } from '$lib/backend-api';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import SyncBackfillSummary from '$lib/components/SyncBackfillSummary.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import {
		formatSyncBackfillAnchoredBlockDuration,
		formatSyncBackfillBlockRange,
		formatSyncBackfillInteger
	} from '$lib/sync-backfill-format';

	let {
		state: syncState,
		basePath,
		collection,
		stack
	}: {
		state: SyncBackfillStateApiResponse | null;
		basePath: string;
		collection: string;
		stack: string[];
	} = $props();

	let submitting = $state(false);
	let feedback: string | null = $state(null);
	let selectedRangeSummary: SyncBackfillRangeSummaryApiResponse | null = $state(null);
	let selectedRangeLoading = $state(false);
	let selectedRangeError: string | null = $state(null);
	let selectedRangeRequestId = 0;

	let selectedCollection = $derived(syncState?.context.selected ?? collection ?? SYNC_BACKFILL_CONTEXT_ANY);
	let depthLevels = $derived(buildDepthLevels());
	let currentPageKey = $derived(
		syncState
			? `${syncState.chain.slug}:${selectedCollection}:${syncState.range.fromBlock}:${syncState.range.toBlock}:${syncState.range.bucketSize}`
			: null
	);
	let selectedRangePageKey: string | null = $state(null);
	let currentSummaryRange: ApiSyncBackfillRangeSummary | null = $derived(
		syncState
			? {
					fromBlock: syncState.range.fromBlock,
					toBlock: syncState.range.toBlock,
					blockCount: syncState.range.blockCount,
					bucketSize: syncState.range.bucketSize,
					syncedBlockCount: syncState.summary.selectedRangeSyncedBlockCount,
					time: syncState.range.time
				}
			: null
	);

	$effect(() => {
		if (selectedRangePageKey === currentPageKey) return;
		selectedRangePageKey = currentPageKey;
		selectedRangeRequestId += 1;
		selectedRangeSummary = null;
		selectedRangeLoading = false;
		selectedRangeError = null;
	});

	function queryHref(nextCollection: string, nextStack: string[]): string {
		const query = new URLSearchParams();
		if (nextCollection && nextCollection !== SYNC_BACKFILL_CONTEXT_ANY) {
			query.set('collection', nextCollection);
		}
		if (nextStack.length > 0) {
			query.set('stack', nextStack.join(','));
		}
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function onCollectionChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		feedback = null;
		void goto(queryHref(target.value, stack));
	}

	async function handleCellClick(event: MouseEvent, cell: ApiSyncBackfillGridCell): Promise<void> {
		if (event.ctrlKey) {
			await loadRangeSummary(cell);
			return;
		}
		if (cell.canDrillDown && syncState) {
			const childBucketSize = syncState.range.bucketSize / SYNC_BACKFILL_GRID_CELL_COUNT;
			if (Number.isInteger(childBucketSize) && childBucketSize >= 1) {
				feedback = null;
				void goto(
					queryHref(selectedCollection, [
						...stack,
						formatPageStackEntry({
							pageStartBlock: cell.fromBlock,
							bucketSize: childBucketSize
						})
					])
				);
			}
			return;
		}
		if (cell.blockCount === 1) {
			await loadRangeSummary(cell);
		}
	}

	async function loadRangeSummary(cell: ApiSyncBackfillGridCell): Promise<void> {
		if (!syncState || cell.blockCount <= 0) return;
		const requestId = selectedRangeRequestId + 1;
		selectedRangeRequestId = requestId;
		selectedRangeLoading = true;
		selectedRangeError = null;
		try {
			const params = new URLSearchParams();
			params.set('from_block', String(cell.fromBlock));
			params.set('to_block', String(cell.toBlock));
			if (selectedCollection !== SYNC_BACKFILL_CONTEXT_ANY) {
				params.set('collection', selectedCollection);
			}
			const summary = await getSyncBackfillRangeSummary(fetch, syncState.chain.slug, params);
			if (selectedRangeRequestId === requestId) {
				selectedRangeSummary = summary;
			}
		} catch (error) {
			if (selectedRangeRequestId === requestId) {
				selectedRangeError = error instanceof Error ? error.message : 'range request failed';
			}
		} finally {
			if (selectedRangeRequestId === requestId) {
				selectedRangeLoading = false;
			}
		}
	}

	async function queueVisibleRange(): Promise<void> {
		if (!syncState) return;
		submitting = true;
		feedback = null;
		try {
			const result = await scheduleSyncBackfill(fetch, syncState.chain.slug, {
				collectionRef:
					selectedCollection === SYNC_BACKFILL_CONTEXT_ANY ? null : selectedCollection,
				fromBlock: syncState.range.fromBlock,
				toBlock: syncState.range.toBlock
			});
			feedback = `queued ${result.queuedJobs} job${result.queuedJobs === 1 ? '' : 's'}`;
			await invalidateAll();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'backfill request failed';
		} finally {
			submitting = false;
		}
	}

	function cellClass(cell: ApiSyncBackfillGridCell): string {
		return `sync-grid-cell sync-grid-cell-${cell.state}`;
	}

	function cellLabel(cell: ApiSyncBackfillGridCell): string {
		const range = formatRange(cell.fromBlock, cell.toBlock, cell.blockCount);
		const duration =
			cell.blockCount > 0 ? `, ${formatVisibleBlockDuration(cell.blockCount)}` : '';
		const action = cell.canDrillDown
			? ', ctrl-click for range details'
			: cell.blockCount === 1
				? ', click for block details'
				: '';
		return `${range}: ${formatSyncBackfillInteger(cell.syncedBlockCount)}/${formatSyncBackfillInteger(cell.blockCount)} synced${duration}${action}`;
	}

	function formatRange(fromBlock: number, toBlock: number, blockCount: number): string {
		if (blockCount <= 0) return 'outside range';
		if (fromBlock === toBlock) return `block ${formatSyncBackfillInteger(fromBlock)}`;
		return formatSyncBackfillBlockRange(fromBlock, toBlock);
	}

	function buildDepthLevels(): Array<{
		key: string;
		label: string;
		range: string;
		href: string;
		active: boolean;
	}> {
		if (!syncState) return [];
		const rootRange = formatSyncBackfillBlockRange(
			syncState.summary.genesisBlock,
			syncState.summary.headBlock
		);
		return [
			{
				key: 'root',
				label: 'root',
				range: rootRange,
				href: queryHref(selectedCollection, []),
				active: stack.length === 0
			},
			...stack.map((entry, index) => {
				const page = parsePageStackEntry(entry);
				return {
					key: `${index + 1}:${entry}`,
					label: `L${index + 1}`,
					range: page ? formatPageRange(page, syncState.summary.headBlock) : entry,
					href: queryHref(selectedCollection, stack.slice(0, index + 1)),
					active: index === stack.length - 1
				};
			})
		];
	}

	function parsePageStackEntry(
		entry: string
	): { pageStartBlock: number; bucketSize: number } | null {
		const [pageStartRaw, bucketSizeRaw, extra] = entry.split(':');
		const pageStartBlock = Number(pageStartRaw);
		const bucketSize = Number(bucketSizeRaw);
		if (
			extra !== undefined ||
			!Number.isInteger(pageStartBlock) ||
			!Number.isInteger(bucketSize) ||
			pageStartBlock < 0 ||
			bucketSize <= 0
		) {
			return null;
		}
		return { pageStartBlock, bucketSize };
	}

	function formatPageStackEntry(page: { pageStartBlock: number; bucketSize: number }): string {
		return `${page.pageStartBlock}:${page.bucketSize}`;
	}

	function formatPageRange(
		page: { pageStartBlock: number; bucketSize: number },
		headBlock: number
	): string {
		const pageEndBlock = page.pageStartBlock + page.bucketSize * SYNC_BACKFILL_GRID_CELL_COUNT - 1;
		return formatSyncBackfillBlockRange(page.pageStartBlock, Math.min(pageEndBlock, headBlock));
	}

	function formatVisibleBlockDuration(blockCount: number): string {
		if (!syncState) return 'unknown';
		return formatSyncBackfillAnchoredBlockDuration({
			blockCount,
			pageBlockCount: syncState.range.blockCount,
			pageDurationSeconds: syncState.range.time.durationSeconds,
			averageBlockTimeSeconds: syncState.chain.averageBlockTimeSeconds
		});
	}

</script>

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={syncState?.chain.slug ?? null} active="sync-backfill" />

	<header class="panel-header sync-backfill-controls-header">
		<div>
			<p class="panel-subtitle">
				{#if syncState}
					{syncState.chain.name} ({syncState.chain.slug} / {syncState.chain.publicChainId})
				{:else}
					Loading chain...
				{/if}
			</p>
		</div>
		<div class="sync-toolbar">
			<label class="status-form" for="sync-collection">
				<span>context</span>
				<select id="sync-collection" value={selectedCollection} onchange={onCollectionChange}>
					<option value={SYNC_BACKFILL_CONTEXT_ANY}>any</option>
					{#each syncState?.context.collections ?? [] as option}
						<option value={option.slug}>{option.slug}</option>
					{/each}
				</select>
			</label>
		</div>
	</header>

	{#if syncState}
		{#if currentSummaryRange}
			<SyncBackfillSummary
				chain={syncState.chain}
				range={currentSummaryRange}
				ariaLabel="Sync summary"
			/>
		{/if}

		<div class="sync-grid-layout">
			<div class="sync-grid-wrap">
				<div
					class="sync-grid"
					style={`--sync-grid-dimension: ${SYNC_BACKFILL_GRID_DIMENSION}`}
					aria-label="Block sync coverage grid"
				>
					{#each syncState.grid as cell (cell.index)}
						<button
							type="button"
							class={cellClass(cell)}
							disabled={cell.blockCount <= 0}
							title={cellLabel(cell)}
							aria-label={cellLabel(cell)}
							onclick={(event) => handleCellClick(event, cell)}
						></button>
					{/each}
				</div>
			</div>
			<aside class="sync-side-panel">
				<nav class="sync-depth-rail" aria-label="Sync depth levels">
					{#each depthLevels as level}
						{#if level.active}
							<span class="sync-depth-level sync-depth-level-active">
								<span class="sync-depth-level-name">{level.label}</span>
								<span class="sync-depth-level-range">{level.range}</span>
							</span>
						{:else}
							<a class="sync-depth-level" href={level.href}>
								<span class="sync-depth-level-name">{level.label}</span>
								<span class="sync-depth-level-range">{level.range}</span>
							</a>
						{/if}
					{/each}
				</nav>
				{#if selectedRangeLoading}
					<div class="sync-range-detail-status muted">loading range</div>
				{:else if selectedRangeError}
					<div class="sync-range-detail-status muted">{selectedRangeError}</div>
				{:else if selectedRangeSummary}
					<SyncBackfillSummary
						chain={selectedRangeSummary.chain}
						range={selectedRangeSummary.range}
						ariaLabel="Selected range summary"
					/>
				{/if}
			</aside>
		</div>

		<div class="sync-backfill-actions">
			<button type="button" onclick={queueVisibleRange} disabled={!syncState || submitting}>
				{submitting ? 'queueing...' : 'backfill range'}
			</button>
			{#if feedback}
				<span class="muted">{feedback}</span>
			{/if}
		</div>
	{:else}
		<div class="empty-cell">loading sync state</div>
	{/if}
</section>
