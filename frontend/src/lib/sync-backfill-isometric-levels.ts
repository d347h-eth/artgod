import {
	SYNC_BACKFILL_GRID_CELL_COUNT,
	SYNC_BACKFILL_GRID_DIMENSION
} from '@artgod/shared/config/sync-backfill';
import type { ApiSyncBackfillGridCell, SyncBackfillStateApiResponse } from '$lib/api-types';

// Visible sync/backfill levels represent the current URL path, not the full chain tree.
export type SyncBackfillVisibleLevel = {
	key: string;
	label: string;
	stack: string[];
	state: SyncBackfillStateApiResponse;
};

export type SyncBackfillIsometricSlot = {
	key: string;
	row: number;
	column: number;
	cell: ApiSyncBackfillGridCell | null;
};

export type SyncBackfillIsometricPoint = {
	x: number;
	y: number;
};

// Client-space anchors let the page draw overlays without coupling to renderer internals.
export type SyncBackfillIsometricAnchorLayout = {
	levelKey: string;
	gridLeftCorner: SyncBackfillIsometricPoint;
	gridRightCorner: SyncBackfillIsometricPoint;
	sourceLeftCorner: SyncBackfillIsometricPoint | null;
	sourceRightCorner: SyncBackfillIsometricPoint | null;
};

// Resolve the presentation square for a level without changing its block-range math.
export function resolveSyncBackfillIsometricDimension(cellCount: number): number {
	if (cellCount <= 0) return 1;
	if (cellCount === SYNC_BACKFILL_GRID_CELL_COUNT) return SYNC_BACKFILL_GRID_DIMENSION;
	return Math.ceil(Math.sqrt(cellCount));
}

// Build render slots and padded blanks for an isometric level.
export function buildSyncBackfillIsometricSlots(
	cells: ApiSyncBackfillGridCell[]
): SyncBackfillIsometricSlot[] {
	const dimension = resolveSyncBackfillIsometricDimension(cells.length);
	return Array.from({ length: dimension * dimension }, (_, index) => ({
		key: cells[index] ? `cell:${cells[index].index}` : `pad:${index}`,
		row: Math.floor(index / dimension),
		column: index % dimension,
		cell: cells[index] ?? null
	}));
}

// Capture live grid content changes that require the SVG renderer to redraw.
export function buildSyncBackfillIsometricLevelRenderKey(level: SyncBackfillVisibleLevel): string {
	const range = level.state.range;
	const summary = level.state.summary;
	const gridKey = level.state.grid
		.map((cell) =>
			[
				cell.index,
				cell.fromBlock,
				cell.toBlock,
				cell.blockCount,
				cell.syncedBlockCount,
				cell.state,
				cell.collectionDeploymentBlock?.synced ? 'deployment-synced' : '',
				cell.collectionDeploymentBlock?.blockNumber ?? ''
			].join(':')
		)
		.join(',');
	return [
		level.key,
		range.fromBlock,
		range.toBlock,
		range.bucketSize,
		range.gridCellCount,
		summary.headBlock,
		summary.highestSyncedBlock ?? '',
		summary.selectedRangeSyncedBlockCount,
		gridKey
	].join('|');
}
