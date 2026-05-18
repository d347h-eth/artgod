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
	let canGoUp = $derived(stack.length > 0);

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

	function goRoot(): void {
		feedback = null;
		void goto(queryHref(selectedCollection, []));
	}

	function goUp(): void {
		feedback = null;
		void goto(queryHref(selectedCollection, stack.slice(0, -1)));
	}

	function drill(cell: ApiSyncBackfillGridCell): void {
		if (!cell.canDrillDown || cell.blockCount <= 1) return;
		feedback = null;
		void goto(queryHref(selectedCollection, [...stack, `${cell.fromBlock}-${cell.toBlock}`]));
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
		return `${range}: ${cell.syncedBlockCount}/${cell.blockCount} synced`;
	}

	function formatRange(fromBlock: number, toBlock: number, blockCount: number): string {
		if (blockCount <= 0) return 'outside range';
		if (fromBlock === toBlock) return `block ${fromBlock}`;
		return `${fromBlock}-${toBlock}`;
	}

	function formatNullableBlock(value: number | null): string {
		return value === null ? 'none' : String(value);
	}
</script>

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={syncState?.chain.slug ?? null} active="sync-backfill" />

	<header class="panel-header">
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
			<button type="button" onclick={goRoot} disabled={!syncState || stack.length === 0}>root</button>
			<button type="button" onclick={goUp} disabled={!syncState || !canGoUp}>up</button>
			<button type="button" onclick={queueVisibleRange} disabled={!syncState || submitting}>
				{submitting ? 'queueing...' : 'backfill range'}
			</button>
		</div>
	</header>

	{#if syncState}
		<section class="sync-summary" aria-label="Sync summary">
			<div>
				<span class="sync-summary-label">head</span>
				<span>{syncState.summary.headBlock}</span>
			</div>
			<div>
				<span class="sync-summary-label">highest synced</span>
				<span>{formatNullableBlock(syncState.summary.highestSyncedBlock)}</span>
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
						onclick={() => drill(cell)}
					></button>
				{/each}
			</div>
		</div>

		<footer class="panel-footer">
			<span class="muted">
				{selectedCollection === SYNC_BACKFILL_CONTEXT_ANY ? 'any' : selectedCollection}
				{syncState.summary.headSource === 'indexed' ? ' / indexed head' : ''}
			</span>
			{#if feedback}
				<span class="muted">{feedback}</span>
			{/if}
		</footer>
	{:else}
		<div class="empty-cell">loading sync state</div>
	{/if}
</section>
