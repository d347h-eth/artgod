import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CollectionBiddingView from './CollectionBiddingView.svelte';

describe('CollectionBiddingView', () => {
	it('renders bidding jobs with inline token controls', () => {
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
							deltaEth: '0.01'
						},
						runtime: {
							currentPriceEth: '0.15',
							activeOrderId: '0xabc123',
							activeProtocolAddress: '0xdef456',
							activeExpirationTimeMs: 1_760_000_000_000,
							lastRunAt: '2026-01-02T00:00:00Z',
							lastError: null
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
							deltaEth: '0.01'
						},
						runtime: null
					}
				],
				bidBook: {
					state: {
						source: 'bot_snapshot',
						snapshotRefreshedAtMs: 1_760_000_000_000,
						projectedAt: '2026-01-02T00:00:00Z',
						rowCount: 1,
						durationMs: 12,
						lastError: null
					},
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
							seenAt: '2026-01-02T00:00:00Z'
						}
					]
				},
				facets: [],
				basePath: '/ethereum/milady',
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedTraitRanges: [],
				bidScope: 'traits',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('<span class="runtime-tab-active">bidding</span>');
		expect(body).toContain(
			'/ethereum/milady/customization?media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain(
			'/ethereum/milady/1?media_mode=artifact&amp;returnPath=%2Fethereum%2Fmilady%2Fbidding&amp;returnQuery=media_mode%3Dartifact%26bid_scope%3Dtraits%26traits%3DHat%253ABeanie'
		);
		expect(body).toContain('token 1');
		expect(body).toContain('save');
		expect(body).toContain('archive');
		expect(body).toContain('bids source');
		expect(body).toContain('0.10');
		expect(body).not.toContain('0.1 WETH');
		expect(body).toContain('placed');
		expect(body).not.toContain('placed at');
		expect(body).toContain('valid');
		expect(body).not.toContain('valid until');
		expect(body).toContain('collection scope');
		expect(body).toContain('Bid scope filter');
		expect(body).toContain('<span class="secondary-tab-active">traits</span>');
		expect(body).toContain('/ethereum/milady/bidding?media_mode=artifact&amp;traits=Hat%3ABeanie');
	});
});
