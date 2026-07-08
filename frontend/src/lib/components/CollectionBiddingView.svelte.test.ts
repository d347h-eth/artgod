import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import {
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import type { ApiBiddingBidBookRow } from '$lib/api-types';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import CollectionBiddingView from './CollectionBiddingView.svelte';

function exactPrice(wei: string, eth: string): ApiBiddingBidBookRow['price'] {
	return {
		kind: 'exact',
		wei,
		eth
	};
}

function marketMaterialization(): ApiBiddingBidBookRow['materialization'] {
	return {
		kind: 'market_bid',
		jobId: null,
		status: null,
		phase: null
	};
}

function ownQueuedMaterialization(): ApiBiddingBidBookRow['materialization'] {
	return {
		kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
		jobId: 'job-token-1',
		status: TRADING_JOB_STATUS.Enabled,
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued
	};
}

describe('CollectionBiddingView', () => {
	it('omits trait filtering chrome for the collection bid-book scope', () => {
		const { body } = render(CollectionBiddingView, {
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
				biddingSettings: defaultBiddingCollectionSettings(),
				bidBook: {
					state: {
						source: 'orders',
						updatedAt: '2026-01-02T00:00:00Z',
						snapshotRefreshedAtMs: null,
						projectedAt: null,
						rowCount: 1,
						durationMs: null,
						lastError: null
					},
					ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					bids: [
						{
							orderId: '0xcollection-bid',
							source: 'orders',
							materialization: marketMaterialization(),
							scope: {
								kind: 'collection',
								label: 'collection',
								tokenId: null,
								traits: []
							},
							maker: {
								address: '0x9999999999999999999999999999999999999999',
								label: '0x9999999999999999999999999999999999999999',
								isOwn: false
							},
							price: exactPrice('100000000000000000', '0.1'),
							bidLimits: null,
							quantity: '1',
							currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
							currencySymbol: 'WETH',
							protocolAddress: null,
							validUntil: 1_900_000_000,
							placedAt: '2026-01-02T00:00:00Z',
							snapshotRefreshedAtMs: null,
							seenAt: '2026-01-02T00:00:00Z',
							ownStatus: null
						}
					]
				},
				facets: [
					{
						key: 'Hat',
						displayKind: 'set',
						minValue: null,
						maxValue: null,
						values: [{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }]
					}
				],
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				},
				basePath: '/ethereum/milady',
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedTraitRanges: [],
				bidScope: 'collection',
				traitJoinMode: 'or',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled="">collection</button>'
		);
		expect(body).toContain('refresh pace');
		expect(body).not.toContain('facet-panel-controls-row');
		expect(body).not.toContain('class="facet-column"');
		expect(body).not.toContain('class="detail-layout"');
		expect(body).not.toContain('filter [or]');
		expect(body).not.toContain('>Hat=Beanie<');
		expect(body).toContain('placeholder="maker address/.eth"');
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection&amp;maker=0x9999999999999999999999999999999999999999'
		);
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection&amp;maker=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		);
		expect(body).toContain('>my bids</a>');
	});

	it('renders token-scoped offers as token cards without trait join controls', () => {
		const { body } = render(CollectionBiddingView, {
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
				biddingSettings: defaultBiddingCollectionSettings(),
				bidBook: {
					state: {
						source: 'orders',
						updatedAt: '2026-01-02T00:00:00Z',
						snapshotRefreshedAtMs: null,
						projectedAt: null,
						rowCount: 2,
						durationMs: null,
						lastError: null
					},
					ownMakerAddress: null,
					bids: [
						{
							orderId: '0xtoken-bid-1',
							source: 'orders',
							materialization: marketMaterialization(),
							scope: {
								kind: 'token',
								label: '#1',
								tokenId: '1',
								traits: []
							},
							maker: {
								address: '0x9999999999999999999999999999999999999999',
								label: '0x9999999999999999999999999999999999999999',
								isOwn: false
							},
							price: exactPrice('420000000000000000', '0.42'),
							bidLimits: null,
							quantity: '1',
							currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
							currencySymbol: 'WETH',
							protocolAddress: null,
							validUntil: 1_900_000_000,
							placedAt: '2026-01-02T00:00:00Z',
							snapshotRefreshedAtMs: null,
							seenAt: '2026-01-02T00:00:00Z',
							ownStatus: null
						}
					]
				},
				tokenOfferCards: {
					items: [
						{
							tokenId: '1',
							marketplaceBiddingSupported: true,
							name: 'Milady #1',
							image: 'https://example.com/milady-1.png',
							animationUrl: null,
							traitSummary: 'Hat=Beanie',
							listingPrice: '500000000000000000',
							listingCurrency: '0x0000000000000000000000000000000000000000',
							attributes: [{ key: 'Hat', value: 'Beanie' }],
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z',
							offers: [
								{
									orderId: '0xtoken-bid-1',
									source: 'orders',
									materialization: marketMaterialization(),
									scope: {
										kind: 'token',
										label: '#1',
										tokenId: '1',
										traits: []
									},
									maker: {
										address: '0x9999999999999999999999999999999999999999',
										label: '0x9999999999999999999999999999999999999999',
										isOwn: false
									},
									price: exactPrice('420000000000000000', '0.42'),
									bidLimits: null,
									quantity: '1',
									currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
									currencySymbol: 'WETH',
									protocolAddress: null,
									validUntil: 1_900_000_000,
									placedAt: '2026-01-02T00:00:00Z',
									snapshotRefreshedAtMs: null,
									seenAt: '2026-01-02T00:00:00Z',
									ownStatus: null
								},
								{
									orderId: 'job-token-1',
									source: 'orders',
									materialization: ownQueuedMaterialization(),
									scope: {
										kind: 'token',
										label: '#1',
										tokenId: '1',
										traits: []
									},
									maker: {
										address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
										label: 'You',
										isOwn: true
									},
									price: exactPrice('100000000000000000', '0.1'),
									bidLimits: null,
									quantity: '1',
									currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
									currencySymbol: 'WETH',
									protocolAddress: null,
									validUntil: 1_900_000_000,
									placedAt: null,
									snapshotRefreshedAtMs: null,
									seenAt: '2026-01-02T00:00:00Z',
									ownStatus: null
								}
							]
						}
					],
					prevCursor: 'prev-page',
					nextCursor: 'next-page',
					limit: 250,
					totalItems: 500,
					marketplaceBiddingSupportedTotalItems: 500,
					totalOffers: 2,
					rangeStart: 251,
					rangeEnd: 251,
					currentPage: 2,
					totalPages: 2
				},
				facets: [
					{
						key: 'Hat',
						displayKind: 'set',
						minValue: null,
						maxValue: null,
						values: [{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }]
					}
				],
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				},
				basePath: '/ethereum/milady',
				selectedTraits: [],
				selectedTraitRanges: [],
				bidScope: 'token',
				traitJoinMode: 'or',
				makerFilter: '0x9999999999999999999999999999999999999999',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled="">token</button>'
		);
		expect(body).toContain('https://example.com/milady-1.png');
		expect(body).toContain('Hat=Beanie');
		expect(body).toContain('ask-price');
		expect(body).toContain('0.5 ETH');
		expect(body).toContain('bid-price');
		expect(body).toContain('0.42 WETH');
		expect(body).toContain('2 offers');
		expect(body).toContain('bid-book-own-status-queued');
		expect(body).toContain('>queued</span>');
		expect(body).toContain('500 tokens');
		expect(body).toContain('showing 251-251 of 500');
		expect(body.indexOf('showing 251-251 of 500')).toBeGreaterThan(
			body.indexOf('https://example.com/milady-1.png')
		);
		expect(body.indexOf('load previous')).toBeLessThan(
			body.indexOf('https://example.com/milady-1.png')
		);
		expect(body.indexOf('load next')).toBeGreaterThan(
			body.indexOf('https://example.com/milady-1.png')
		);
		expect(body).toContain('load next');
		expect(body).toContain('class="facet-panel-controls-row"');
		expect(body).not.toContain('facet-filter-mode-button');
	});

	it('renders explicit collection bid-scope links so stored preferences do not override scope clicks', () => {
		const { body } = render(CollectionBiddingView, {
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
				biddingSettings: defaultBiddingCollectionSettings(),
				bidBook: {
					state: {
						source: 'orders',
						updatedAt: '2026-01-02T00:00:00Z',
						snapshotRefreshedAtMs: null,
						projectedAt: null,
						rowCount: 0,
						durationMs: null,
						lastError: null
					},
					ownMakerAddress: '0x9999999999999999999999999999999999999999',
					bids: []
				},
				facets: [],
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				},
				basePath: '/ethereum/milady',
				selectedTraits: [],
				selectedTraitRanges: [],
				bidScope: 'traits',
				traitJoinMode: 'or',
				makerFilter: '0x9999999999999999999999999999999999999999',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled="">traits</button>'
		);
		expect(body).toContain('/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection');
		expect(body).toContain('value="0x9999999999999999999999999999999999999999"');
		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled="">my bids</button>'
		);
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection&amp;maker=0x9999999999999999999999999999999999999999'
		);
	});
});
