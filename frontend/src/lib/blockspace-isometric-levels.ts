import {
	BLOCKSPACE_GRID_CELL_COUNT,
	BLOCKSPACE_GRID_DIMENSION
} from '@artgod/shared/config/blockspace';
import type { ApiBlockspaceGridCell, BlockspaceStateApiResponse } from '$lib/api-types';

// Visible blockspace levels represent the current URL path, not the full chain tree.
export type BlockspaceVisibleLevel = {
	key: string;
	label: string;
	stack: string[];
	state: BlockspaceStateApiResponse;
};

export type BlockspaceIsometricSlot = {
	key: string;
	row: number;
	column: number;
	cell: ApiBlockspaceGridCell | null;
};

export type BlockspaceIsometricPoint = {
	x: number;
	y: number;
};

// Client-space anchors let the page draw overlays without coupling to renderer internals.
export type BlockspaceIsometricAnchorLayout = {
	levelKey: string;
	gridTopCorner: BlockspaceIsometricPoint;
	gridLeftCorner: BlockspaceIsometricPoint;
	gridRightCorner: BlockspaceIsometricPoint;
	gridBottomCorner: BlockspaceIsometricPoint;
	sourceLeftCorner: BlockspaceIsometricPoint | null;
	sourceRightCorner: BlockspaceIsometricPoint | null;
};

// Resolve the presentation square for a level without changing its block-range math.
export function resolveBlockspaceIsometricDimension(cellCount: number): number {
	if (cellCount <= 0) return 1;
	if (cellCount === BLOCKSPACE_GRID_CELL_COUNT) return BLOCKSPACE_GRID_DIMENSION;
	return Math.ceil(Math.sqrt(cellCount));
}

// Build render slots and padded blanks for an isometric level.
export function buildBlockspaceIsometricSlots(
	cells: ApiBlockspaceGridCell[]
): BlockspaceIsometricSlot[] {
	const dimension = resolveBlockspaceIsometricDimension(cells.length);
	return Array.from({ length: dimension * dimension }, (_, index) => ({
		key: cells[index] ? `cell:${cells[index].index}` : `pad:${index}`,
		row: Math.floor(index / dimension),
		column: index % dimension,
		cell: cells[index] ?? null
	}));
}

// Capture live grid content changes that require the SVG renderer to redraw.
export function buildBlockspaceIsometricLevelRenderKey(level: BlockspaceVisibleLevel): string {
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
