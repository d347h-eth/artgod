import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CollectionBiddingView from './CollectionBiddingView.svelte';

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
				jobs: [],
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
							priceWei: '100000000000000000',
							priceEth: '0.1',
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
						values: [{ value: 'Beanie', tokenCount: 1 }]
					}
				],
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				},
				included: {
					tokensById: {},
					hasTraitSummaryTemplate: false
				},
				basePath: '/ethereum/milady',
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedTraitRanges: [],
				bidScope: 'collection',
				traitJoinMode: 'or',
				biddingView: 'bid_book',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled>collection</button>'
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
				jobs: [],
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
							priceWei: '420000000000000000',
							priceEth: '0.42',
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
							name: 'Milady #1',
							image: 'https://example.com/milady-1.png',
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
									priceWei: '420000000000000000',
									priceEth: '0.42',
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
						}
					],
					prevCursor: 'prev-page',
					nextCursor: 'next-page',
					limit: 250,
					totalItems: 500,
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
						values: [{ value: 'Beanie', tokenCount: 1 }]
					}
				],
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [{ key: 'artifact', label: 'artifact' }]
				},
				included: {
					tokensById: {},
					hasTraitSummaryTemplate: false
				},
				basePath: '/ethereum/milady',
				selectedTraits: [],
				selectedTraitRanges: [],
				bidScope: 'token',
				traitJoinMode: 'or',
				biddingView: 'bid_book',
				makerFilter: '0x9999999999999999999999999999999999999999',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('<button type="button" class="secondary-tab-active" disabled>token</button>');
		expect(body).toContain('https://example.com/milady-1.png');
		expect(body).toContain('Hat=Beanie');
		expect(body).toContain('ask-price');
		expect(body).toContain('0.5 ETH');
		expect(body).toContain('bid-price');
		expect(body).toContain('0.42 WETH');
		expect(body).toContain('1 offer');
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

	it('renders bidding jobs as a read-only diagnostics table', () => {
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
				jobs: [
					{
						jobId: 'job-token-1',
						status: 'enabled',
						revision: 3,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-02T00:00:00Z',
						archivedAt: null,
						target: {
							type: 'token',
							tokenId: '1'
						},
						config: {
							floorEth: '0.1',
							ceilingEth: '0.2',
							deltaEth: '0.01',
							pricingSource: null
						},
						runtime: {
							currentPriceEth: '0.15',
							activeOrderId: '0xabc123',
							activeProtocolAddress: '0xdef456',
							activeExpirationTimeMs: 1_760_000_000_000,
							lastRunAt: '2026-01-02T00:00:00Z',
							lastError: null,
							updatedAt: '2026-01-02T00:00:30Z'
						}
					},
					{
						jobId: 'job-collection-1',
						status: 'paused',
						revision: 1,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T12:00:00Z',
						archivedAt: null,
						target: {
							type: 'collection',
							quantity: 2,
							targetTraits: [{ type: 'Hat', value: 'Beanie' }]
						},
						config: {
							floorEth: '0.05',
							ceilingEth: '0.15',
							deltaEth: '0.01',
							pricingSource: null
						},
						runtime: null
					}
				],
				bidBook: {
					state: {
						source: 'bot_snapshot',
						updatedAt: '2025-10-09T08:53:20Z',
						snapshotRefreshedAtMs: 1_760_000_000_000,
						projectedAt: '2026-01-02T00:00:00Z',
						rowCount: 1,
						durationMs: 12,
						lastError: null
					},
					ownMakerAddress: null,
					bids: [
						{
							orderId: '0xbid1',
							source: 'bot_snapshot',
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
							priceWei: '100000000000000000',
							priceEth: '0.1',
							quantity: '1',
							currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
							currencySymbol: 'WETH',
							protocolAddress: null,
							validUntil: 1_900_000_000,
							placedAt: '2026-01-02T00:00:00Z',
							snapshotRefreshedAtMs: 1_760_000_000_000,
							seenAt: '2026-01-02T00:00:00Z',
							ownStatus: null
						}
					]
				},
				facets: [],
				media: {
					selectedMode: 'snapshot',
					defaultMode: 'snapshot',
					availableModes: [{ key: 'snapshot', label: 'snapshot' }]
				},
				included: {
					tokensById: {
						'1': {
							tokenId: '1',
							name: 'Milady #1',
							image: 'https://example.com/milady-1.png',
							traitSummary: 'Hat=Beanie',
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					},
					hasTraitSummaryTemplate: true
				},
				basePath: '/ethereum/milady',
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedTraitRanges: [],
				bidScope: 'traits',
				traitJoinMode: 'or',
				biddingView: 'jobs',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('<span class="runtime-tab-active">bidding</span>');
		expect(body).toContain(
			'/ethereum/milady/customization?media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain(
			'/ethereum/milady/1?media_mode=artifact&amp;returnPath=%2Fethereum%2Fmilady%2Fbidding&amp;returnQuery=media_mode%3Dartifact%26bidding_view%3Djobs%26bid_scope%3Dtraits%26traits%3DHat%253ABeanie'
		);
		expect(body).toContain('token 1');
		expect(body).toContain('activity-token-cell');
		expect(body).toContain('https://example.com/milady-1.png');
		expect(body).toContain('<span class="mono">enabled</span>');
		expect(body).toContain('<span class="mono">paused</span>');
		expect(body).toContain('<span class="mono">0.1</span>');
		expect(body).not.toContain('save');
		expect(body).not.toContain('archive');
		expect(body).not.toContain('<th>actions</th>');
		expect(body).not.toContain('bidding-row-actions');
		expect(body).toContain('token jobs');
		expect(body).toContain('other scopes');
		expect(body).not.toContain('bids source');
		expect(body).not.toContain('0.10');
		expect(body).toContain('collection scope');
		expect(body).not.toContain('Bid scope filter');
		expect(body).not.toContain('Bidding view');
		expect(body).toContain('<span class="runtime-tab-active">bidding</span>');
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=traits&amp;traits=Hat%3ABeanie'
		);
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
				jobs: [],
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
				included: {
					tokensById: {},
					hasTraitSummaryTemplate: false
				},
				basePath: '/ethereum/milady',
				selectedTraits: [],
				selectedTraitRanges: [],
				bidScope: 'traits',
				traitJoinMode: 'or',
				biddingView: 'bid_book',
				makerFilter: '0x9999999999999999999999999999999999999999',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled>traits</button>'
		);
		expect(body).toContain('/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection');
		expect(body).toContain('value="0x9999999999999999999999999999999999999999"');
		expect(body).toContain(
			'<button type="button" class="secondary-tab-active" disabled>my bids</button>'
		);
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection&amp;maker=0x9999999999999999999999999999999999999999'
		);
	});
});
