import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { buildBiddingAutomationDraftFromBid } from '$lib/bidding-automation';
import BiddingAutomationPanel from './BiddingAutomationPanel.svelte';

describe('BiddingAutomationPanel', () => {
	it('renders token job runtime state and editable scalar fields when open', () => {
		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
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
				token: {
					tokenId: '1',
					name: 'Milady #1',
					image: 'https://example.com/1.png',
					animationUrl: null,
					listingPrice: null,
					listingCurrency: null,
					currentHolder: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					attributes: [],
					hasMetadata: true,
					metadataUpdatedAt: '2026-01-01T00:00:00Z'
				},
				job: {
					jobId: 'job-token-1',
					status: 'enabled',
					revision: 2,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T12:00:00Z',
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
						activeExpirationTimeMs: 1760000000000,
						lastRunAt: '2026-01-01T13:00:00Z',
						lastError: null
					}
				},
				bidBook: {
					state: {
						source: 'orders',
						updatedAt: null,
						snapshotRefreshedAtMs: null,
						projectedAt: null,
						rowCount: 0,
						durationMs: null,
						lastError: null
					},
					bids: []
				},
				onClose: () => {},
				onJobChange: () => {}
			}
		});

		expect(body).toContain('role="dialog"');
		expect(body).toContain('token bidding');
		expect(body).toContain('0.15 ETH');
		expect(body).toContain('0xabc123');
		expect(body).toContain('value="0.1"');
		expect(body).toContain('value="0.2"');
		expect(body).toContain('value="0.01"');
		expect(body).toContain('>archive<');
	});

	it('renders selected trait bid drafts as unavailable for submit in the token-only write pass', () => {
		const draft = buildBiddingAutomationDraftFromBid({
			orderId: '0xtrait-bid',
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
				address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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
		});

		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
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
				token: null,
				job: null,
				draft,
				onClose: () => {}
			}
		});

		expect(body).toContain('Biome=42 + Mode=Terrain');
		expect(body).toContain('not available');
		expect(body).toContain('value="0.3"');
		expect(body).toContain('disabled');
	});
});
