import { describe, expect, it } from 'vitest';
import type { SyncBackfillStateApiResponse } from './api-types';
import {
	buildSyncBackfillStackFetchPlan,
	buildSyncBackfillStackStateApiParams,
	buildSyncBackfillStateApiParams,
	buildSyncBackfillVisibleStackPages,
	buildSyncBackfillVisibleStackPagesFromEntries,
	buildSyncBackfillVisibleLevels,
	formatSyncBackfillPageStackEntry,
	parseSyncBackfillPageStack,
	resolveSyncBackfillStackAnchorLevelKey
} from './sync-backfill-page-stack';

describe('sync backfill page stack', () => {
	it('parses and formats visible child page stack entries', () => {
		const stack = parseSyncBackfillPageStack('1024:32,2048:1');

		expect(stack).toEqual([
			{ pageStartBlock: 1024, bucketSize: 32 },
			{ pageStartBlock: 2048, bucketSize: 1 }
		]);
		expect(stack?.map(formatSyncBackfillPageStackEntry)).toEqual(['1024:32', '2048:1']);
	});

	it('rejects malformed stack entries', () => {
		expect(parseSyncBackfillPageStack('1024:0')).toBeNull();
		expect(parseSyncBackfillPageStack('-1:32')).toBeNull();
		expect(parseSyncBackfillPageStack('1024:32:extra')).toBeNull();
	});

	it('builds backend query params for root and child pages', () => {
		expect(buildSyncBackfillStateApiParams('any', null).toString()).toBe('collection=any');
		expect(
			buildSyncBackfillStateApiParams('terraforms', {
				pageStartBlock: 1024,
				bucketSize: 32
			}).toString()
		).toBe('collection=terraforms&page_start=1024&bucket_size=32');
	});

	it('builds ordered visible stack pages including root', () => {
		expect(buildSyncBackfillVisibleStackPages(['1024:32', '2048:1'])).toEqual([
			null,
			{ pageStartBlock: 1024, bucketSize: 32 },
			{ pageStartBlock: 2048, bucketSize: 1 }
		]);
		expect(
			buildSyncBackfillVisibleStackPagesFromEntries([
				{ pageStartBlock: 1024, bucketSize: 32 },
				{ pageStartBlock: 2048, bucketSize: 1 }
			])
		).toEqual([
			null,
			{ pageStartBlock: 1024, bucketSize: 32 },
			{ pageStartBlock: 2048, bucketSize: 1 }
		]);
	});

	it('builds backend query params for visible stack pages', () => {
		expect(
			buildSyncBackfillStackStateApiParams('terraforms', [
				null,
				{ pageStartBlock: 1024, bucketSize: 32 }
			]).map((params) => params.toString())
		).toEqual([
			'collection=terraforms',
			'collection=terraforms&page_start=1024&bucket_size=32'
		]);
	});

	it('builds render levels from fetched page states', () => {
		const levels = buildSyncBackfillVisibleLevels(['1024:32'], [
			buildState(0),
			buildState(1024)
		]);

		expect(levels).toMatchObject([
			{ key: 'root', label: 'root', stack: [] },
			{ key: 'L1:1024:32', label: 'L1', stack: ['1024:32'] }
		]);
	});

	it('plans only changed child suffix fetches when switching sibling buckets', () => {
		const levels = buildSyncBackfillVisibleLevels(['1024:32', '2048:1'], [
			buildState(0),
			buildState(1024),
			buildState(2048)
		]);

		const plan = buildSyncBackfillStackFetchPlan(
			['1024:32', '2048:1'],
			['1024:32', '3072:1'],
			levels
		);

		expect(plan.reusedStates.map((state) => state.range.fromBlock)).toEqual([0, 1024]);
		expect(plan.pagesToFetch).toEqual([{ pageStartBlock: 3072, bucketSize: 1 }]);
	});

	it('reuses root when switching top-level buckets', () => {
		const levels = buildSyncBackfillVisibleLevels(['1024:32', '2048:1'], [
			buildState(0),
			buildState(1024),
			buildState(2048)
		]);

		const plan = buildSyncBackfillStackFetchPlan(['1024:32', '2048:1'], ['4096:32'], levels);

		expect(plan.reusedStates.map((state) => state.range.fromBlock)).toEqual([0]);
		expect(plan.pagesToFetch).toEqual([{ pageStartBlock: 4096, bucketSize: 32 }]);
	});

	it('reuses all destination levels when navigating back to an ancestor stack', () => {
		const levels = buildSyncBackfillVisibleLevels(['1024:32', '2048:1'], [
			buildState(0),
			buildState(1024),
			buildState(2048)
		]);

		const plan = buildSyncBackfillStackFetchPlan(['1024:32', '2048:1'], ['1024:32'], levels);

		expect(plan.reusedStates.map((state) => state.range.fromBlock)).toEqual([0, 1024]);
		expect(plan.pagesToFetch).toEqual([]);
	});

	it('falls back to full visible-stack fetches when no current levels are reusable', () => {
		const plan = buildSyncBackfillStackFetchPlan([], ['1024:32'], []);

		expect(plan.reusedStates).toEqual([]);
		expect(plan.pagesToFetch).toEqual([null, { pageStartBlock: 1024, bucketSize: 32 }]);
	});

	it('resolves a stable transition anchor from the deepest common level', () => {
		const levels = buildSyncBackfillVisibleLevels(['1024:32', '2048:1'], [
			buildState(0),
			buildState(1024),
			buildState(2048)
		]);

		expect(
			resolveSyncBackfillStackAnchorLevelKey(
				['1024:32', '2048:1'],
				['1024:32', '3072:1'],
				levels
			)
		).toBe('L1:1024:32');
		expect(
			resolveSyncBackfillStackAnchorLevelKey(['1024:32', '2048:1'], ['4096:32'], levels)
		).toBe('root');
	});
});

function buildState(fromBlock: number): SyncBackfillStateApiResponse {
	return {
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
			fromBlock,
			toBlock: fromBlock,
			blockCount: 1,
			bucketSize: 1,
			gridCellCount: 1,
			canDrillDown: false,
			time: {
				from: { blockNumber: fromBlock, timestamp: 0, source: 'db' },
				to: { blockNumber: fromBlock, timestamp: 0, source: 'db' },
				durationSeconds: 0
			}
		},
		summary: {
			genesisBlock: 0,
			headBlock: fromBlock,
			headSource: 'indexed',
			highestSyncedBlock: null,
			syncedBlockCount: 0,
			selectedRangeSyncedBlockCount: 0
		},
		grid: []
	};
}
