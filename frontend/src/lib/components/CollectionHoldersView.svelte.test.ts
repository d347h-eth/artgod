import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CollectionHoldersView from './CollectionHoldersView.svelte';

describe('CollectionHoldersView', () => {
	it('renders holders table with append-only pagination summary', () => {
		const { body } = render(CollectionHoldersView, {
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
				holders: {
					items: [
						{
							owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							tokenCount: '12'
						},
						{
							owner: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
							tokenCount: '7'
						}
					],
					nextCursor: 'opaque-cursor-2',
					limit: 2,
					totalItems: 4,
					rangeStart: 1,
					rangeEnd: 2,
					currentPage: 1,
					totalPages: 2
				},
				basePath: '/ethereum/milady',
				requestCursor: null
			}
		});

		expect(body).toContain('holders');
		expect(body).toContain('position');
		expect(body).toContain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		expect(body).toContain('12');
		expect(body).toContain('4 holders');
		expect(body).toContain('showing 1-2 of 4');
		expect(body).toContain('load next');
		expect(body).toContain('/ethereum/milady/holders');
	});
});
