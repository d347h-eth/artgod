import {
	GetSyncBackfillStateUseCase,
	type SyncBackfillCoverageContext,
	type SyncBackfillReadPort
} from '../../backend/src/application/use-cases/sync-backfill/get-sync-backfill-state';
import { BLOCKSPACE_QUERY_PARAMS } from '@artgod/shared/config/blockspace';
import { COLLECTION_STATUS } from '@artgod/shared/types';

export const BLOCKSPACE_E2E = {
	path: '/e2e-harness/blockspace',
	apiPattern: '**/api/ethereum/blockspace**',
	head: 25_000_000,
	deployment: 24_000_100,
	anchor: 24_000_200,
	collections: ['anchor-first', 'anchor-second'],
	query: { coverage: 'coverage', coincident: 'coincident' },
	coverage: { empty: 'empty', deployment: 'deployment', both: 'both' }
} as const;

// Exercise the actual Blockspace use case and wire shape without DB/RPC services.
export function blockspaceFixtureUseCase(params: URLSearchParams) {
	const coincident = params.has(BLOCKSPACE_E2E.query.coincident);
	const coverage = params.get(BLOCKSPACE_E2E.query.coverage) ?? BLOCKSPACE_E2E.coverage.empty;
	const collections = BLOCKSPACE_E2E.collections.map((slug, index) => ({
		chainId: 1,
		collectionId: index + 1,
		slug,
		address: `0x${String(index + 1).padStart(40, '0')}`,
		status: COLLECTION_STATUS.Live,
		deploymentBlock: BLOCKSPACE_E2E.deployment,
		bootstrapAnchorBlock: coincident
			? BLOCKSPACE_E2E.deployment
			: BLOCKSPACE_E2E.anchor + index * 200,
		bootstrapLastSyncedBlock: BLOCKSPACE_E2E.head
	}));
	const covered = (context: SyncBackfillCoverageContext) => {
		if (context.kind === 'any') return [];
		const collection = collections.find((item) => item.collectionId === context.collectionId)!;
		return coverage === BLOCKSPACE_E2E.coverage.empty
			? []
			: [
					...new Set([
						collection.deploymentBlock,
						...(coverage === BLOCKSPACE_E2E.coverage.both ? [collection.bootstrapAnchorBlock] : [])
					])
				];
	};
	const count = (context: SyncBackfillCoverageContext, from: number, to: number) => {
		if (to < from) return 0;
		return context.kind === 'any'
			? to - from + 1
			: covered(context).filter((block) => from <= block && block <= to).length;
	};
	const readPort: SyncBackfillReadPort = {
		listBlockspaceCollections: () => collections,
		getHighestSyncedBlock: () => BLOCKSPACE_E2E.head,
		getBlockTimestamp: (_chainId, block) => block * 12,
		countSyncedBlocks: (_chainId, context) => count(context, 0, BLOCKSPACE_E2E.head),
		countSyncedBlocksInRange: (_chainId, context, range) =>
			count(context, range.fromBlock, range.toBlock),
		countSyncedBlocksByRange: (_chainId, context, ranges) =>
			ranges.map((range) => ({
				...range,
				syncedBlockCount: count(context, range.fromBlock, range.toBlock)
			}))
	};
	return new GetSyncBackfillStateUseCase(
		1,
		{
			resolveChainRef: () => ({
				id: 1,
				publicChainId: 1,
				type: 'evm',
				slug: 'ethereum',
				name: 'Ethereum',
				averageBlockTimeSeconds: 12,
				genesisBlockNumber: 0,
				genesisBlockTimestamp: 0
			})
		},
		readPort,
		{
			getCurrentBlockNumber: async () => BLOCKSPACE_E2E.head,
			getBlockTimestamp: async (block) => block * 12
		}
	);
}

export async function buildBlockspaceE2EState(params: URLSearchParams) {
	return blockspaceFixtureUseCase(params).getState({
		chainRef: 'ethereum',
		collectionRef: params.get(BLOCKSPACE_QUERY_PARAMS.Collection),
		pageStartBlock: params.has(BLOCKSPACE_QUERY_PARAMS.PageStart)
			? Number(params.get(BLOCKSPACE_QUERY_PARAMS.PageStart))
			: null,
		bucketSize: params.has(BLOCKSPACE_QUERY_PARAMS.BucketSize)
			? Number(params.get(BLOCKSPACE_QUERY_PARAMS.BucketSize))
			: null
	});
}
