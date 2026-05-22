import { describe, expect, it } from 'vitest';
import { BLOCKSPACE_GRID_CELL_COUNT } from '@artgod/shared/config/blockspace';
import type { ApiBlockspaceGridCell } from './api-types';
import {
	buildBlockspaceIsometricSlots,
	buildBlockspaceIsometricLevelRenderKey,
	resolveBlockspaceIsometricDimension,
	type BlockspaceVisibleLevel
} from './blockspace-isometric-levels';

describe('blockspace isometric levels', () => {
	it('keeps full blockspace pages at 32x32', () => {
		expect(resolveBlockspaceIsometricDimension(BLOCKSPACE_GRID_CELL_COUNT)).toBe(32);
	});

	it('uses the smallest square that fits incomplete levels', () => {
		expect(resolveBlockspaceIsometricDimension(24)).toBe(5);
	});

	it('pads incomplete visual levels without changing real cells', () => {
		const cells = Array.from({ length: 24 }, (_, index) => buildCell(index));
		const slots = buildBlockspaceIsometricSlots(cells);
		expect(slots).toHaveLength(25);
		expect(slots[23].cell?.index).toBe(23);
		expect(slots[24].cell).toBeNull();
	});

	it('changes the render key when live coverage changes inside a fixed range', () => {
		const level = buildLevel([buildCell(0), buildCell(1)]);
		const initialKey = buildBlockspaceIsometricLevelRenderKey(level);

		level.state.grid[1] = {
			...level.state.grid[1],
			syncedBlockCount: 1,
			state: 'complete'
		};

		expect(buildBlockspaceIsometricLevelRenderKey(level)).not.toBe(initialKey);
	});
});

function buildCell(index: number): ApiBlockspaceGridCell {
	return {
		index,
		fromBlock: index,
		toBlock: index,
		blockCount: 1,
		syncedBlockCount: 0,
		state: 'empty',
		canDrillDown: false,
		collectionDeploymentBlock: null
	};
}

function buildLevel(cells: ApiBlockspaceGridCell[]) {
	return {
		key: 'root',
		label: 'root',
		stack: [],
		state: {
			chain: {
				id: 1,
				type: 'evm',
				slug: 'ethereum',
				name: 'Ethereum',
				publicChainId: 1,
				averageBlockTimeSeconds: 12,
				genesisBlockNumber: 0,
				genesisBlockTimestamp: 0
			},
			context: {
				selected: 'any',
				collections: []
			},
			range: {
				fromBlock: 0,
				toBlock: cells.length - 1,
				blockCount: cells.length,
				bucketSize: 1,
				gridCellCount: cells.length,
				canDrillDown: false,
				time: {
					from: { blockNumber: 0, timestamp: 0, source: 'chain' },
					to: { blockNumber: cells.length - 1, timestamp: 12, source: 'db' },
					durationSeconds: 12
				}
			},
			summary: {
				genesisBlock: 0,
				headBlock: cells.length - 1,
				headSource: 'indexed',
				highestSyncedBlock: null,
				syncedBlockCount: 0,
				selectedRangeSyncedBlockCount: 0
			},
			grid: cells
		}
	} satisfies BlockspaceVisibleLevel;
}
