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
							payload: null,
							isCollapsed: false,
							collapsedEventCount: null,
							collapsedWindowStartUtc: null,
							collapsedWindowEndUtc: null
						},
						{
							id: 11,
							scopeKind: 'token',
							kind: 'sale',
							contract: '0x1111111111111111111111111111111111111111',
							tokenId: '1',
							occurredAt: 1725920000,
							sourceKind: 'onchain',
							sourceName: 'seaport',
							orderId: 'order-0',
							blockNumber: 22000000,
							txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
							logIndex: 1,
							from: '0x8888888888888888888888888888888888888888',
							to: '0x7777777777777777777777777777777777777777',
							maker: '0x8888888888888888888888888888888888888888',
							taker: '0x7777777777777777777777777777777777777777',
							side: 'sell',
							amount: '1',
							price: '400000000000000000',
							currency: '0x0000000000000000000000000000000000000000',
							payload: null,
							isCollapsed: false,
							collapsedEventCount: null,
							collapsedWindowStartUtc: null,
							collapsedWindowEndUtc: null
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
				facets: [{ key: 'Hat', values: [{ value: 'Beanie', tokenCount: 1 }] }],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				included: {
					tokensById: {
						'1': {
							tokenId: '1',
							name: 'Milady #1',
							image: 'https://example.com/1.png',
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					}
				},
				basePath: '/ethereum/milady',
				filterKind: 'sales'
			}
		});

		expect(body).toContain('activities');
		expect(body).toContain('id');
		expect(body).toContain('price');
		expect(body).toContain('image');
		expect(body).toContain('name');
		expect(body).toContain('from');
		expect(body).toContain('to');
		expect(body).toContain('time');
		expect(body).toContain('sales');
		expect(body).toContain('listings');
		expect(body).toContain('transfers');
		expect(body).toContain('traits');
		expect(body).toContain('Beanie');
		expect(body).toContain('>traits<');
		expect(body).toContain('>reset<');
		expect(body).toContain('relative');
		expect(body).toContain('<span class="secondary-tab-active">sales</span>');
		expect(body).toContain('/ethereum/milady?limit=25&amp;mode=grid&amp;token_status=listed&amp;traits=Hat%3ABeanie');
		expect(body).toContain('/ethereum/milady/activity?limit=25&amp;kind=listings&amp;traits=Hat%3ABeanie');
		expect(body).toContain('/ethereum/milady/1');
		expect(body).toContain('Milady #1');
		expect(body).toContain('https://example.com/1.png');
		expect(body).toContain('preview token 1');
		expect(body).toContain('0.5 ETH');
		expect(body).toContain(
			'https://opensea.io/item/ethereum/0x1111111111111111111111111111111111111111/1'
		);
		expect(body).toContain('0x9999...9999');
		expect(body).toContain('0xaaaa...aaaa');
		expect(body).toContain(
			'/ethereum/milady/holders/0x9999999999999999999999999999999999999999'
		);
		expect(body).toContain(
			'/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		);
		expect(body).toContain('title="2024-09-10 20:33:20 UTC"');
		expect(body).toContain(
			'https://etherscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		);
		expect(body).toContain('older');
		expect(body).toContain('class="activities-day-break-label">2024-09-09 UTC</span>');
		expect(body).not.toContain('>details<');
		expect(body).not.toContain('token</th>');
	});

	it('uses a reduced listings column set without the to column and marks UTC day breaks', () => {
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
							id: 3,
							scopeKind: 'token',
							kind: 'listing_created',
							contract: '0x1111111111111111111111111111111111111111',
							tokenId: '1',
							occurredAt: 1726090000,
							sourceKind: 'offchain',
							sourceName: 'opensea',
							orderId: 'order-2',
							blockNumber: null,
							txHash: null,
							logIndex: null,
							from: null,
							to: null,
							maker: '0x9999999999999999999999999999999999999999',
							taker: null,
							side: 'sell',
							amount: null,
							price: '510000000000000000',
							currency: '0x0000000000000000000000000000000000000000',
							payload: null,
							isCollapsed: true,
							collapsedEventCount: 2,
							collapsedWindowStartUtc: 1726012800,
							collapsedWindowEndUtc: 1726099199
						},
						{
							id: 2,
							scopeKind: 'token',
							kind: 'listing_created',
							contract: '0x1111111111111111111111111111111111111111',
							tokenId: '1',
							occurredAt: 1726000200,
							sourceKind: 'offchain',
							sourceName: 'opensea',
							orderId: 'order-1',
							blockNumber: null,
							txHash: null,
							logIndex: null,
							from: null,
							to: null,
							maker: '0x9999999999999999999999999999999999999999',
							taker: null,
							side: 'sell',
							amount: null,
							price: '500000000000000000',
							currency: '0x0000000000000000000000000000000000000000',
							payload: null,
							isCollapsed: true,
							collapsedEventCount: 3,
							collapsedWindowStartUtc: 1725926400,
							collapsedWindowEndUtc: 1726012799
						}
					],
					prevCursor: null,
					nextCursor: null,
					limit: 25,
					totalItems: 1,
					rangeStart: 1,
					rangeEnd: 1,
					currentPage: 1,
					totalPages: 1
				},
				facets: [{ key: 'Hat', values: [{ value: 'Beanie', tokenCount: 1 }] }],
				selectedTraits: [],
				included: {
					tokensById: {
						'1': {
							tokenId: '1',
							name: 'Milady #1',
							image: 'https://example.com/1.png',
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					}
				},
				basePath: '/ethereum/milady',
				filterKind: 'listings'
			}
		});

		expect(body).toContain('from');
		expect(body).toContain('time');
		expect(body).not.toContain('>to<');
		expect(body).toContain('0x9999...9999');
		expect(body).toContain('class="activities-day-break-label">2024-09-10 UTC</span>');
	});
});
