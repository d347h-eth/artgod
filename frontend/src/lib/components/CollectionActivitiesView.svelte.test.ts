import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CollectionActivitiesView from './CollectionActivitiesView.svelte';

describe('CollectionActivitiesView', () => {
	it('renders collection activity rows with grouped filter navigation', () => {
		const { body } = render(CollectionActivitiesView, {
			props: {
				chain: {
					id: 1,
					type: 'evm',
					publicChainId: 1,
					slug: 'ethereum',
					name: 'Ethereum'
				},
				collection: {
					chainId: 1,
					collectionId: 1,
					slug: 'milady',
					address: '0x1111111111111111111111111111111111111111',
					standard: 'erc721',
					status: 'live',
					deploymentBlock: 1,
					bootstrapAnchorBlock: null,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z'
				},
				activities: {
					items: [
						{
							id: 1,
							scopeKind: 'token',
							kind: 'sale',
							contract: '0x1111111111111111111111111111111111111111',
							tokenId: '1',
							occurredAt: 1726000400,
							sourceKind: 'onchain',
							sourceName: 'seaport',
							orderId: 'order-1',
							blockNumber: 22000100,
							txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							logIndex: 3,
							from: '0x9999999999999999999999999999999999999999',
							to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							maker: '0x9999999999999999999999999999999999999999',
							taker: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							side: 'sell',
							amount: '1',
							price: '500000000000000000',
							currency: '0x0000000000000000000000000000000000000000',
							payload: null
						}
					],
					prevCursor: null,
					nextCursor: 'opaque-next',
					limit: 25,
					totalItems: 1,
					rangeStart: 1,
					rangeEnd: 1,
					currentPage: 1,
					totalPages: 1
				},
				basePath: '/ethereum/milady',
				filterKind: 'sales'
			}
		});

		expect(body).toContain('activities');
		expect(body).toContain('sales');
		expect(body).toContain('listings');
		expect(body).toContain('transfers');
		expect(body).toContain('/ethereum/milady/activity?kind=sales');
		expect(body).toContain('/ethereum/milady/activity?limit=25&amp;kind=listings');
		expect(body).toContain('#1');
		expect(body).toContain('0.5 ETH');
		expect(body).toContain('older');
	});
});
