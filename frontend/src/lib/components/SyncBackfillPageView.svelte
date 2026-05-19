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

	type BlockRangeSelection = {
		fromBlock: number;
		toBlock: number;
		bucketSize: number;
	};

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
	let backfillSelectionMode = $state(false);
	let backfillSelectionFromBlock: number | null = $state(null);
	let backfillSelectionRange: BlockRangeSelection | null = $state(null);

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
		backfillSelectionMode = false;
		backfillSelectionFromBlock = null;
		backfillSelectionRange = null;
		clearRangeSummary();
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
		if (backfillSelectionMode) {
			await handleBackfillSelectionClick(cell);
			return;
		}
		if (event.ctrlKey) {
			await loadRangeSummary({
				fromBlock: cell.fromBlock,
				toBlock: cell.toBlock,
				bucketSize: syncState?.range.bucketSize ?? cell.blockCount
			});
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
			await loadRangeSummary({
				fromBlock: cell.fromBlock,
				toBlock: cell.toBlock,
				bucketSize: syncState?.range.bucketSize ?? cell.blockCount
			});
		}
	}

	async function handleBackfillSelectionClick(cell: ApiSyncBackfillGridCell): Promise<void> {
		if (!syncState || cell.blockCount <= 0) return;
		feedback = null;
		if (backfillSelectionFromBlock === null) {
			backfillSelectionFromBlock = cell.fromBlock;
			backfillSelectionRange = null;
			clearRangeSummary();
			return;
		}

		const nextRange = {
			fromBlock: backfillSelectionFromBlock,
			toBlock: cell.toBlock,
			bucketSize: syncState.range.bucketSize
		};
		if (nextRange.toBlock < nextRange.fromBlock) {
			feedback = `select to block >= ${formatSyncBackfillInteger(nextRange.fromBlock)}`;
			return;
		}

		backfillSelectionFromBlock = null;
		backfillSelectionRange = nextRange;
		await loadRangeSummary(nextRange);
	}

	function beginBackfillSelection(): void {
		if (!syncState) return;
		backfillSelectionMode = true;
		backfillSelectionFromBlock = null;
		backfillSelectionRange = null;
		feedback = null;
		clearRangeSummary();
	}

	function cancelBackfillSelection(): void {
		backfillSelectionMode = false;
		backfillSelectionFromBlock = null;
		backfillSelectionRange = null;
		feedback = null;
		clearRangeSummary();
	}

	function clearRangeSummary(): void {
		selectedRangeRequestId += 1;
		selectedRangeSummary = null;
		selectedRangeLoading = false;
		selectedRangeError = null;
	}

	async function loadRangeSummary(range: BlockRangeSelection): Promise<void> {
		if (!syncState || range.fromBlock > range.toBlock) return;
		const requestId = selectedRangeRequestId + 1;
		selectedRangeRequestId = requestId;
		selectedRangeLoading = true;
		selectedRangeError = null;
		try {
			const params = new URLSearchParams();
			params.set('from_block', String(range.fromBlock));
			params.set('to_block', String(range.toBlock));
			if (selectedCollection !== SYNC_BACKFILL_CONTEXT_ANY) {
				params.set('collection', selectedCollection);
			}
			const summary = await getSyncBackfillRangeSummary(fetch, syncState.chain.slug, params);
			if (selectedRangeRequestId === requestId) {
				selectedRangeSummary = {
					...summary,
					range: {
						...summary.range,
						bucketSize: range.bucketSize
					}
				};
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

	async function commitBackfillSelection(): Promise<void> {
		if (!syncState || !backfillSelectionRange) return;
		submitting = true;
		feedback = null;
		try {
			const result = await scheduleSyncBackfill(fetch, syncState.chain.slug, {
				collectionRef:
					selectedCollection === SYNC_BACKFILL_CONTEXT_ANY ? null : selectedCollection,
				fromBlock: backfillSelectionRange.fromBlock,
				toBlock: backfillSelectionRange.toBlock
			});
			feedback = `queued ${result.queuedJobs} job${result.queuedJobs === 1 ? '' : 's'}`;
			backfillSelectionMode = false;
			backfillSelectionFromBlock = null;
			backfillSelectionRange = null;
			await invalidateAll();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'backfill request failed';
		} finally {
			submitting = false;
		}
	}

	function cellClass(cell: ApiSyncBackfillGridCell): string {
		const classes = ['sync-grid-cell', `sync-grid-cell-${cell.state}`];
		if (cell.collectionDeploymentBlock) {
			classes.push(
				cell.collectionDeploymentBlock.synced
					? 'sync-grid-cell-deployment-synced'
					: 'sync-grid-cell-deployment-unsynced'
			);
		}
		if (isSelectionCell(cell)) {
			classes.push('sync-grid-cell-selected');
		}
		return classes.join(' ');
	}

	function cellLabel(cell: ApiSyncBackfillGridCell): string {
		const range = formatRange(cell.fromBlock, cell.toBlock, cell.blockCount);
		const duration =
			cell.blockCount > 0 ? `, ${formatVisibleBlockDuration(cell.blockCount)}` : '';
		const marker = cell.collectionDeploymentBlock
			? `, deployment block ${formatSyncBackfillInteger(cell.collectionDeploymentBlock.blockNumber)} ${
					cell.collectionDeploymentBlock.synced ? 'synced' : 'not synced'
				}`
			: '';
		const action = resolveCellActionLabel(cell);
		return `${range}: ${formatSyncBackfillInteger(cell.syncedBlockCount)}/${formatSyncBackfillInteger(cell.blockCount)} synced${duration}${marker}${action}`;
	}

	function formatRange(fromBlock: number, toBlock: number, blockCount: number): string {
		if (blockCount <= 0) return 'outside range';
		if (fromBlock === toBlock) return `block ${formatSyncBackfillInteger(fromBlock)}`;
		return formatSyncBackfillBlockRange(fromBlock, toBlock);
	}

	function resolveCellActionLabel(cell: ApiSyncBackfillGridCell): string {
		if (backfillSelectionMode) {
			return backfillSelectionFromBlock === null
				? ', click to select from block'
				: ', click to select to block';
		}
		if (cell.canDrillDown) return ', ctrl-click for range details';
		if (cell.blockCount === 1) return ', click for block details';
		return '';
	}

	function isSelectionCell(cell: ApiSyncBackfillGridCell): boolean {
		if (!backfillSelectionMode || cell.blockCount <= 0) return false;
		if (backfillSelectionRange) {
			return rangesOverlap(cell, backfillSelectionRange);
		}
		return rangeContainsBlock(cell, backfillSelectionFromBlock);
	}

	function rangesOverlap(cell: ApiSyncBackfillGridCell, range: BlockRangeSelection): boolean {
		return cell.fromBlock <= range.toBlock && range.fromBlock <= cell.toBlock;
	}

	function rangeContainsBlock(
		cell: ApiSyncBackfillGridCell,
		blockNumber: number | null
	): boolean {
		return blockNumber !== null && cell.fromBlock <= blockNumber && blockNumber <= cell.toBlock;
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
					class={`sync-grid ${backfillSelectionMode ? 'sync-grid-selection-mode' : ''}`}
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

		<div
			class={`sync-backfill-actions ${backfillSelectionMode ? 'sync-backfill-actions-selection' : ''}`}
		>
			{#if backfillSelectionMode}
				<button
					type="button"
					class="action-button-negative"
					onclick={cancelBackfillSelection}
					disabled={submitting}
				>
					cancel
				</button>
				<button
					type="button"
					class="action-button-positive"
					onclick={commitBackfillSelection}
					disabled={!backfillSelectionRange || submitting}
				>
					{submitting ? 'queueing...' : 'commit to backfill'}
				</button>
			{:else}
				<button type="button" onclick={beginBackfillSelection} disabled={!syncState || submitting}>
					backfill range
				</button>
			{/if}
			{#if feedback}
				<span class="muted">{feedback}</span>
			{/if}
		</div>
	{:else}
		<div class="empty-cell">loading sync state</div>
	{/if}
</section>
