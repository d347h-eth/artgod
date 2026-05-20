import { describe, expect, it } from 'vitest';
import { SYNC_BACKFILL_GRID_CELL_COUNT } from '@artgod/shared/config/sync-backfill';
import type { ApiSyncBackfillGridCell } from './api-types';
import {
	buildSyncBackfillIsometricSlots,
	resolveSyncBackfillIsometricDimension
} from './sync-backfill-isometric-levels';

describe('sync backfill isometric levels', () => {
	it('keeps full sync backfill pages at 32x32', () => {
		expect(resolveSyncBackfillIsometricDimension(SYNC_BACKFILL_GRID_CELL_COUNT)).toBe(32);
	});

	it('uses the smallest square that fits incomplete levels', () => {
		expect(resolveSyncBackfillIsometricDimension(24)).toBe(5);
	});

	it('pads incomplete visual levels without changing real cells', () => {
		const cells = Array.from({ length: 24 }, (_, index) => buildCell(index));
		const slots = buildSyncBackfillIsometricSlots(cells);
		expect(slots).toHaveLength(25);
		expect(slots[23].cell?.index).toBe(23);
		expect(slots[24].cell).toBeNull();
	});
});

function buildCell(index: number): ApiSyncBackfillGridCell {
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
