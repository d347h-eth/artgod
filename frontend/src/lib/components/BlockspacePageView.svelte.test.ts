import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { BLOCKSPACE_CONTEXT_ANY } from '@artgod/shared/config/blockspace';
import type { BlockspaceStateApiResponse } from '$lib/api-types';
import BlockspacePageView from './BlockspacePageView.svelte';

vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	pushState: vi.fn()
}));

vi.mock('$app/state', () => ({
	page: {
		url: new URL('http://artgod.local/ethereum/blockspace'),
		state: {}
	}
}));

describe('BlockspacePageView', () => {
	it('renders a collection jump link when the selected context is a collection', () => {
		const { body } = render(BlockspacePageView, {
			props: {
				state: buildBlockspaceState('terraforms'),
				levels: [],
				basePath: '/ethereum/blockspace',
				collection: 'terraforms',
				stack: [],
				showListNavigation: false,
				canCommitBackfill: false
			}
		});

		expect(body).toContain('>jump to collection</a>');
		expect(body).toContain('href="/ethereum/terraforms?');
		expect(body).toContain('token_status=listed');
	});

	it('does not render a collection jump link for the aggregate context', () => {
		const { body } = render(BlockspacePageView, {
			props: {
				state: buildBlockspaceState(BLOCKSPACE_CONTEXT_ANY),
				levels: [],
				basePath: '/ethereum/blockspace',
				collection: BLOCKSPACE_CONTEXT_ANY,
				stack: [],
				showListNavigation: false,
				canCommitBackfill: false
			}
		});

		expect(body).not.toContain('jump to collection');
	});
});

function buildBlockspaceState(selectedCollection: string): BlockspaceStateApiResponse {
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
			selected: selectedCollection,
			collections: [buildCollectionOption('terraforms')]
		},
		range: {
			fromBlock: 0,
			toBlock: 0,
			blockCount: 1,
			bucketSize: 1,
			gridCellCount: 1,
			canDrillDown: false,
			time: {
				from: { blockNumber: 0, timestamp: 0, source: 'db' },
				to: { blockNumber: 0, timestamp: 0, source: 'db' },
				durationSeconds: 0
			}
		},
		summary: {
			genesisBlock: 0,
			headBlock: 0,
			headSource: 'indexed',
			highestSyncedBlock: null,
			syncedBlockCount: 0,
			selectedRangeSyncedBlockCount: 0
		},
		grid: []
	};
}

function buildCollectionOption(slug: string): BlockspaceStateApiResponse['context']['collections'][number] {
	return {
		chainId: 1,
		collectionId: 1,
		slug,
		address: '0x1111111111111111111111111111111111111111',
		status: 'live',
		deploymentBlock: 0,
		bootstrapAnchorBlock: null,
		bootstrapLastSyncedBlock: null
	};
}
