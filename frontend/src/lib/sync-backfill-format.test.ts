import { describe, expect, it } from 'vitest';
import {
	estimateSyncBackfillBlockTimeMs,
	formatSyncBackfillApproxTimeRange,
	formatSyncBackfillApproxUtc,
	formatSyncBackfillBlockDuration,
	formatSyncBackfillBlockRange,
	formatSyncBackfillSyncedPercent
} from './sync-backfill-format';

describe('sync backfill formatting', () => {
	it('formats block durations from approximate 12 second blocks', () => {
		expect(formatSyncBackfillBlockDuration(0)).toBe('0s');
		expect(formatSyncBackfillBlockDuration(1)).toBe('12s');
		expect(formatSyncBackfillBlockDuration(300)).toBe('1h');
		expect(formatSyncBackfillBlockDuration(1024)).toBe('3h');
		expect(formatSyncBackfillBlockDuration(2_865_900)).toBe('1y 1m 3d 1h');
	});

	it('formats approximate UTC timestamps without suffixes or subseconds', () => {
		expect(formatSyncBackfillApproxUtc(Date.UTC(2026, 4, 19, 18, 30, 45))).toBe(
			'2026-05-19T18:30:45'
		);
	});

	it('derives approximate block timestamps from the visible head', () => {
		const headTimeMs = Date.UTC(2026, 4, 19, 18, 30, 0);

		expect(estimateSyncBackfillBlockTimeMs(98, 100, headTimeMs)).toBe(
			Date.UTC(2026, 4, 19, 18, 29, 36)
		);
		expect(
			formatSyncBackfillApproxTimeRange({
				fromBlock: 98,
				toBlock: 100,
				headBlock: 100,
				headTimeMs
			})
		).toBe('2026-05-19T18:29:36 / 2026-05-19T18:30:00');
	});

	it('formats grouped block ranges and rounded synced percentages', () => {
		const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
		expect(formatSyncBackfillBlockRange(1_024, 1_048_575)).toBe(
			`${formatter.format(1_024)}-${formatter.format(1_048_575)}`
		);
		expect(formatSyncBackfillSyncedPercent(2, 3)).toBe('67%');
		expect(formatSyncBackfillSyncedPercent(0, 0)).toBe('0%');
	});
});
