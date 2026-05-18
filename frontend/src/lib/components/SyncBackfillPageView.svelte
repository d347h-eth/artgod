<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import {
		SYNC_BACKFILL_CONTEXT_ANY,
		SYNC_BACKFILL_GRID_DIMENSION
	} from '@artgod/shared/config/sync-backfill';
	import type { ApiSyncBackfillGridCell, SyncBackfillStateApiResponse } from '$lib/api-types';
	import { scheduleSyncBackfill } from '$lib/backend-api';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';

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

	let selectedCollection = $derived(syncState?.context.selected ?? collection ?? SYNC_BACKFILL_CONTEXT_ANY);
	let depthLevels = $derived(buildDepthLevels());

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

	async function handleCellClick(cell: ApiSyncBackfillGridCell): Promise<void> {
		if (cell.blockCount === 1) {
			await copyTerminalBlock(cell.fromBlock);
			return;
		}
		if (!cell.canDrillDown) return;
		feedback = null;
		void goto(queryHref(selectedCollection, [...stack, `${cell.fromBlock}-${cell.toBlock}`]));
	}

	async function copyTerminalBlock(blockNumber: number): Promise<void> {
		try {
			await navigator.clipboard.writeText(String(blockNumber));
			feedback = `copied block ${blockNumber}`;
		} catch {
			feedback = 'block copy failed';
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
		const action = cell.blockCount === 1 ? ', click to copy block number' : '';
		return `${range}: ${cell.syncedBlockCount}/${cell.blockCount} synced${action}`;
	}

	function formatRange(fromBlock: number, toBlock: number, blockCount: number): string {
		if (blockCount <= 0) return 'outside range';
		if (fromBlock === toBlock) return `block ${fromBlock}`;
		return `${fromBlock}-${toBlock}`;
	}

	function buildDepthLevels(): Array<{
		key: string;
		label: string;
		range: string;
		href: string;
		active: boolean;
	}> {
		if (!syncState) return [];
		const rootRange = `${syncState.summary.genesisBlock}-${syncState.summary.headBlock}`;
		return [
			{
				key: 'root',
				label: 'root',
				range: rootRange,
				href: queryHref(selectedCollection, []),
				active: stack.length === 0
			},
			...stack.map((range, index) => ({
				key: `${index + 1}:${range}`,
				label: `L${index + 1}`,
				range,
				href: queryHref(selectedCollection, stack.slice(0, index + 1)),
				active: index === stack.length - 1
			}))
		];
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
		<section class="sync-summary" aria-label="Sync summary">
			<div>
				<span class="sync-summary-label">observed</span>
				<span>{syncState.range.blockCount} blocks</span>
			</div>
			<div>
				<span class="sync-summary-label">range</span>
				<span>{syncState.range.fromBlock}-{syncState.range.toBlock}</span>
			</div>
			<div>
				<span class="sync-summary-label">bucket</span>
				<span>{syncState.range.bucketSize}</span>
			</div>
			<div>
				<span class="sync-summary-label">synced</span>
				<span>{syncState.summary.selectedRangeSyncedBlockCount}/{syncState.range.blockCount}</span>
			</div>
		</section>

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
							onclick={() => handleCellClick(cell)}
						></button>
					{/each}
				</div>
			</div>
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
