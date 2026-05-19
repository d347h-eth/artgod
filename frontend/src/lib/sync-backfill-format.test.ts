import { describe, expect, it } from 'vitest';
import {
	formatSyncBackfillAnchoredBlockDuration,
	formatSyncBackfillBlockRange,
	formatSyncBackfillDurationSeconds,
	formatSyncBackfillSyncedPercent,
	formatSyncBackfillTimeRange,
	formatSyncBackfillUtc
} from './sync-backfill-format';

describe('sync backfill formatting', () => {
	it('formats anchored durations compactly', () => {
		expect(formatSyncBackfillDurationSeconds(null)).toBe('unknown');
		expect(formatSyncBackfillDurationSeconds(0)).toBe('0s');
		expect(formatSyncBackfillDurationSeconds(12)).toBe('12s');
		expect(formatSyncBackfillDurationSeconds(3_600)).toBe('1h');
		expect(formatSyncBackfillDurationSeconds(34_390_800)).toBe('1y 1m 3d 1h');
	});

	it('derives block durations from page endpoint anchors', () => {
		expect(
			formatSyncBackfillAnchoredBlockDuration({
				blockCount: 6,
				pageBlockCount: 11,
				pageDurationSeconds: 100,
				averageBlockTimeSeconds: 12
			})
		).toBe('50s');
		expect(
			formatSyncBackfillAnchoredBlockDuration({
				blockCount: 6,
				pageBlockCount: 11,
				pageDurationSeconds: null,
				averageBlockTimeSeconds: 12
			})
		).toBe('unknown');
	});

	it('uses chain block duration estimates for single-block buckets', () => {
		expect(
			formatSyncBackfillAnchoredBlockDuration({
				blockCount: 1,
				pageBlockCount: 1024,
				pageDurationSeconds: 12_276,
				averageBlockTimeSeconds: 12
			})
		).toBe('~12s');
		expect(
			formatSyncBackfillAnchoredBlockDuration({
				blockCount: 1,
				pageBlockCount: 1024,
				pageDurationSeconds: 12_276,
				averageBlockTimeSeconds: null
			})
		).toBe('unknown');
	});

	it('formats anchored UTC timestamps without suffixes or subseconds', () => {
		expect(formatSyncBackfillUtc(1_438_269_973)).toBe('2015-07-30T15:26:13');
		expect(formatSyncBackfillUtc(null)).toBe('unknown');
	});

	it('formats anchored UTC time ranges', () => {
		expect(
			formatSyncBackfillTimeRange({
				fromTimestamp: 100,
				toTimestamp: 160
			})
		).toBe('1970-01-01T00:01:40 / 1970-01-01T00:02:40');
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
