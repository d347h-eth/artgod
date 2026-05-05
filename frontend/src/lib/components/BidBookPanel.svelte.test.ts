import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { ApiBiddingBidBook, ApiBiddingBidBookRow } from '$lib/api-types';
import BidBookPanel from './BidBookPanel.svelte';

const BASE_BID: ApiBiddingBidBookRow = {
	orderId: '0xbase',
	source: 'orders',
	scope: {
		kind: 'trait',
		label: 'Biome=42 + Mode=Terrain',
		tokenId: null,
		traits: [
			{ type: 'Biome', value: '42' },
			{ type: 'Mode', value: 'Terrain' }
		]
	},
	maker: {
		address: '0x1111111111111111111111111111111111111111',
		label: '0x1111111111111111111111111111111111111111',
		isOwn: false
	},
	priceWei: '300000000000000000',
	priceEth: '0.3',
	quantity: '1',
	currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
	currencySymbol: 'WETH',
	protocolAddress: null,
	validUntil: 1_900_000_000,
	placedAt: '2026-01-02T00:00:00Z',
	snapshotRefreshedAtMs: null,
	seenAt: '2026-01-02T00:00:00Z'
};

describe('BidBookPanel', () => {
	it('renders individual bids under canonical trait-combination buckets', () => {
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: 'orders',
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 5,
				durationMs: null,
				lastError: null
			},
			bids: [
				{
					...BASE_BID,
					orderId: '0xtrait-a',
					quantity: '2'
				},
				{
					...BASE_BID,
					orderId: '0xtrait-b',
					scope: {
						...BASE_BID.scope,
						label: 'Mode=Terrain + Biome=42',
						traits: [
							{ type: 'Mode', value: 'Terrain' },
							{ type: 'Biome', value: '42' }
						]
					},
					priceWei: '290000000000000000',
					priceEth: '0.29',
					maker: {
						address: '0x2222222222222222222222222222222222222222',
						label: '0x2222222222222222222222222222222222222222',
						isOwn: false
					}
				},
				{
					...BASE_BID,
					orderId: '0xtrait-low',
					priceWei: '300000000000000',
					priceEth: '0.0003',
					maker: {
						address: '0x3333333333333333333333333333333333333333',
						label: '0x3333333333333333333333333333333333333333',
						isOwn: false
					}
				},
				{
					...BASE_BID,
					orderId: '0xsingle-higher',
					scope: {
						kind: 'trait',
						label: 'Chroma=Plague',
						tokenId: null,
						traits: [{ type: 'Chroma', value: 'Plague' }]
					},
					priceWei: '800000000000000000',
					priceEth: '0.8'
				},
				{
					...BASE_BID,
					orderId: '0xmuted-bucket',
					scope: {
						kind: 'trait',
						label: 'Zone=Low',
						tokenId: null,
						traits: [{ type: 'Zone', value: 'Low' }]
					},
					priceWei: '100000000000000000',
					priceEth: '0.1'
				}
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				view: 'trait-demand',
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(body.match(/bid-book-demand-trait-key">Biome</g)).toHaveLength(1);
		expect(body.match(/bid-book-demand-trait-key">Mode</g)).toHaveLength(1);
		expect(body).toContain('bid-book-demand-trait-equals">=</span>');
		expect(body).toContain('bid-book-demand-trait-value">42</span>');
		expect(body).toContain('bid-book-demand-trait-value">Terrain</span>');
		expect(body).not.toContain('Mode=Terrain + Biome=42');
		expect(body.indexOf('bid-book-demand-trait-key">Chroma')).toBeLessThan(
			body.indexOf('bid-book-demand-trait-key">Biome')
		);
		expect(body).toContain('0.30');
		expect(body).toContain('0.29');
		expect(body).toContain('0.00');
		expect(body).not.toContain('0.0003');
		expect(body).toContain('>2x</span>');
		expect(body).toContain('bid-book-price-quantity-empty');
		expect(body).toContain('total');
		expect(body).toContain('0.89');
		expect(body).not.toContain('0.90');
		expect(body).not.toContain('best');
		expect(body.match(/>offers</g)).toHaveLength(1);
		expect(body).toContain('>2</span>');
		expect(body).not.toContain('>qty<');
		expect(body).toContain('All [3]');
		expect(body).toContain('Biome [1]');
		expect(body).toContain('Mode [1]');
		expect(body).toContain('Chroma [1]');
		expect(body).toContain('Zone [1]');
		expect(body.indexOf('All [3]')).toBeLessThan(body.indexOf('Biome [1]'));
		expect(body).toContain('0x1111111111111111111111111111111111111111');
		expect(body).toContain('0x2222222222222222222222222222222222222222');
		expect(body).toContain('0x3333333333333333333333333333333333333333');
		expect(body).toContain('data-open-sea-order-hash="0xtrait-a"');
		expect(body).toContain('data-open-sea-order-hash="0xtrait-b"');
		expect(body).toContain('data-open-sea-order-hash="0xtrait-low"');
		expect(body).toContain('bid-book-muted-row');
		expect(body).toContain('bid-book-muted-demand-group');
		expect(body).toMatch(/<tr(?=[^>]*hidden)(?=[^>]*bid-book-muted-row)[^>]*>/);
		expect(body).toMatch(/<tr(?=[^>]*hidden)(?=[^>]*bid-book-muted-demand-group)[^>]*>/);
		expect(body).not.toContain('aria-label="Bid trait bucket index"');
		expect(body).not.toContain('href="#bid-book-bucket-');
		expect(body).not.toContain(
			'bid-book-bucket-spacer" aria-hidden="true"><td colspan="4"></td></tr><!--]--> <tr class="bid-book-muted-row"'
		);
		expect(body).toContain('targets');
		expect(body).toContain('offers');
		expect(body).toContain('makers');

		const { body: debugBody } = render(BidBookPanel, {
			props: {
				bidBook,
				view: 'trait-demand',
				showMuted: true,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(debugBody).toContain('bid-book-muted-row');
		expect(debugBody).toContain('bid-book-muted-demand-group');
		expect(debugBody).not.toMatch(/<tr(?=[^>]*hidden)(?=[^>]*bid-book-muted-row)[^>]*>/);
		expect(debugBody).not.toMatch(/<tr(?=[^>]*hidden)(?=[^>]*bid-book-muted-demand-group)[^>]*>/);
	});

	it('uses displayed rows only when resolving row price precision', () => {
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: 'orders',
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 3,
				durationMs: null,
				lastError: null
			},
			bids: [
				{
					...BASE_BID,
					orderId: '0xtop',
					scope: {
						kind: 'collection',
						label: 'collection',
						tokenId: null,
						traits: []
					},
					priceWei: '200000000000000000',
					priceEth: '0.2'
				},
				{
					...BASE_BID,
					orderId: '0xnear-top',
					scope: {
						kind: 'collection',
						label: 'collection',
						tokenId: null,
						traits: []
					},
					priceWei: '190000000000000000',
					priceEth: '0.19'
				},
				{
					...BASE_BID,
					orderId: '0xcollapsed-dust',
					scope: {
						kind: 'collection',
						label: 'collection',
						tokenId: null,
						traits: []
					},
					priceWei: '345000000000000',
					priceEth: '0.000345'
				}
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('0.20');
		expect(body).not.toContain('0.200000');
		expect(body).toContain('bid-book-price-quantity-empty');
		expect(body).toContain('expand 1');
		expect(body).not.toContain('0.000345');
	});

	it('renders clickable demand trait values and opens the preferred trait tab', () => {
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: 'orders',
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 1,
				durationMs: null,
				lastError: null
			},
			bids: [{ ...BASE_BID, orderId: '0xclickable-trait' }]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				view: 'trait-demand',
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact',
				preferredDemandTraitKey: 'Mode',
				traitValueHref: (trait: { key: string; value: string }) =>
					`/ethereum/terraforms/bidding?traits=${trait.key}:${trait.value}`
			}
		});

		expect(body).toContain('<span class="secondary-tab-active">Mode [1]</span>');
		expect(body.indexOf('bid-book-demand-trait-key">Mode')).toBeLessThan(
			body.indexOf('bid-book-demand-trait-key">Biome')
		);
		expect(body).toContain('class="bid-book-demand-trait-list"');
		expect(body.match(/bid-book-demand-trait-entry/g)).toHaveLength(2);
		expect(body).toContain('class="bid-book-demand-trait-separator">+</span>');
		expect(body).not.toContain('<span> + </span>');
		expect(body).toContain('class="bid-book-demand-trait-value-link"');
		expect(body).toContain('href="/ethereum/terraforms/bidding?traits=Mode:Terrain"');
		expect(body).toContain('href="/ethereum/terraforms/bidding?traits=Biome:42"');
		expect(body).toContain('>Terrain</a>');
		expect(body).toContain('>42</a>');
	});
});
