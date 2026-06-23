import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import {
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
	TRADING_BIDDING_TIER_SELECTION_MODE,
	TRADING_JOB_TARGET_KIND,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import { buildBiddingAutomationDraftFromBid } from '$lib/bidding-automation';
import type { ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import BiddingAutomationPanel from './BiddingAutomationPanel.svelte';

function exactPrice(wei: string, eth: string): ApiBiddingBidBookRow['price'] {
	return {
		kind: 'exact',
		wei,
		eth
	};
}

describe('BiddingAutomationPanel', () => {
	it('renders token job state and editable scalar fields when open', () => {
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
						deltaEth: '0.01',
						pricingSource: null
					},
					runtime: {
						currentPriceEth: '0.15',
						activeOrderId: '0xabc123',
						activeProtocolAddress: '0xdef456',
						activeExpirationTimeMs: 1760000000000,
						bidPosition: null,
						bidConstraints: [],
						competitorPriceEth: null,
						lastRunAt: '2026-01-01T13:00:00Z',
						lastError: null,
						updatedAt: '2026-01-01T13:00:30Z'
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
					ownMakerAddress: null,
					bids: []
				},
				onClose: () => {},
				onJobChange: () => {}
			}
		});

		expect(body).toContain('role="dialog"');
		expect(body).toContain('>bidding<');
		expect(body).toContain('>state<');
		expect(body).toContain('>queued</span>');
		expect(body).not.toContain('>current price<');
		expect(body).not.toContain('>active order<');
		expect(body).toContain('value="0.1"');
		expect(body).toContain('value="0.2"');
		expect(body).toContain('value="0.01"');
		expect(body).toContain('>modified<');
		expect(body).toContain('>refreshed<');
		expect(body).not.toContain('bidding-automation-status');
		expect(body).toContain('>modify<');
		expect(body).toContain('>pause<');
		expect(body).toContain('>archive<');
	});

	it('renders backend-owned market bid state for the current job', () => {
		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
				chain: testChain(),
				collection: testCollection(),
				token: testToken(),
				job: testTokenJob(TRADING_JOB_STATUS.Enabled),
				bidBook: {
					state: {
						source: 'bot_snapshot',
						updatedAt: null,
						snapshotRefreshedAtMs: null,
						projectedAt: null,
						rowCount: 1,
						durationMs: null,
						lastError: null
					},
					ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					bids: [
						{
							orderId: '0xown-token',
							source: 'bot_snapshot',
							materialization: {
								kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
								jobId: null,
								status: null,
								phase: null
							},
							scope: {
								kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
								label: '#1',
								tokenId: '1',
								traits: []
							},
							maker: {
								address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
								label: 'You',
								isOwn: true
							},
							price: exactPrice('200000000000000000', '0.2'),
							quantity: '1',
							currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
							currencySymbol: 'WETH',
							protocolAddress: null,
							validUntil: 1_900_000_000,
							placedAt: '2026-01-02T00:00:00Z',
							snapshotRefreshedAtMs: null,
							seenAt: '2026-01-02T00:00:00Z',
							ownStatus: {
								position: 'winning',
								constraints: ['ceiling'],
								job: {
									jobId: 'job-token-1',
									revision: 2,
									status: TRADING_JOB_STATUS.Enabled
								}
							}
						}
					]
				},
				onClose: () => {},
				onJobChange: () => {}
			}
		});

		expect(body).toContain('>state<');
		expect(body).toContain('>winning</span>');
		expect(body).toContain('>hit ceiling</span>');
		expect(body).not.toContain('>queued</span>');
	});

	it('uses the collection default delta for empty manual drafts', () => {
		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
				chain: testChain(),
				collection: testCollection(),
				token: testToken(),
				job: null,
				biddingSettings: {
					tierSelectionMode: TRADING_BIDDING_TIER_SELECTION_MODE.Buttons,
					defaultDeltaEth: '0.004',
					updatedAt: null
				}
			}
		});

		expect(body).toContain('value="0.004"');
	});

	it('renders selected trait bid drafts as submittable collection-scope jobs', () => {
		const draft = buildBiddingAutomationDraftFromBid({
			orderId: '0xtrait-bid',
			source: 'orders',
			materialization: {
				kind: 'market_bid',
				jobId: null,
				status: null,
				phase: null
			},
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
			price: exactPrice('300000000000000000', '0.3'),
			quantity: '1',
			currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
			currencySymbol: 'WETH',
			protocolAddress: null,
			validUntil: 1_900_000_000,
			placedAt: '2026-01-02T00:00:00Z',
			snapshotRefreshedAtMs: null,
			seenAt: '2026-01-02T00:00:00Z',
			ownStatus: null
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
		expect(body).not.toContain('not available');
		expect(body).toContain('value="0.301"');
		expect(body).toContain('value="0.001"');
		expect(body).toContain('>create<');
		expect(body).toContain('disabled>pause<');
		expect(body).toContain('disabled>archive<');
	});

	it('prefers an existing trait job config over selected-bid draft pricing', () => {
		const existingTraitJob: ApiBiddingJob = {
			jobId: 'job-trait-1',
			status: TRADING_JOB_STATUS.Enabled,
			revision: 2,
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T12:00:00Z',
			archivedAt: null,
			target: {
				type: TRADING_JOB_TARGET_KIND.Collection,
				quantity: 1,
				targetTraits: [{ type: 'Biome', value: '42' }]
			},
			config: {
				floorEth: '0.2',
				ceilingEth: '0.4',
				deltaEth: '0.01',
				pricingSource: null
			},
			runtime: null
		};
		const draft = buildBiddingAutomationDraftFromBid({
			orderId: '0xtrait-bid',
			source: 'orders',
			materialization: {
				kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
				jobId: null,
				status: null,
				phase: null
			},
			scope: {
				kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
				label: 'Biome=42',
				tokenId: null,
				traits: [{ type: 'Biome', value: '42' }]
			},
			maker: {
				address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				isOwn: false
			},
			price: exactPrice('300000000000000000', '0.3'),
			quantity: '1',
			currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
			currencySymbol: 'WETH',
			protocolAddress: null,
			validUntil: 1_900_000_000,
			placedAt: '2026-01-02T00:00:00Z',
			snapshotRefreshedAtMs: null,
			seenAt: '2026-01-02T00:00:00Z',
			ownStatus: null
		}, existingTraitJob);

		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
				chain: testChain(),
				collection: testCollection(),
				token: null,
				job: null,
				draft,
				onClose: () => {}
			}
		});

		expect(body).toContain('value="0.2"');
		expect(body).toContain('value="0.4"');
		expect(body).toContain('value="0.01"');
		expect(body).not.toContain('value="0.301"');
		expect(body).toContain('disabled>modify<');
	});

	it('does not apply the page token job to a selected trait bid draft', () => {
		const draft = buildBiddingAutomationDraftFromBid({
			orderId: '0xtrait-bid',
			source: 'orders',
			materialization: {
				kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
				jobId: null,
				status: null,
				phase: null
			},
			scope: {
				kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
				label: 'Biome=42',
				tokenId: null,
				traits: [{ type: 'Biome', value: '42' }]
			},
			maker: {
				address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				isOwn: false
			},
			price: exactPrice('300000000000000000', '0.3'),
			quantity: '1',
			currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
			currencySymbol: 'WETH',
			protocolAddress: null,
			validUntil: 1_900_000_000,
			placedAt: '2026-01-02T00:00:00Z',
			snapshotRefreshedAtMs: null,
			seenAt: '2026-01-02T00:00:00Z',
			ownStatus: null
		});

		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
				chain: testChain(),
				collection: testCollection(),
				token: testToken(),
				job: testTokenJob(TRADING_JOB_STATUS.Enabled),
				draft,
				onClose: () => {}
			}
		});

		expect(body).toContain('Biome=42');
		expect(body).toContain('value="0.301"');
		expect(body).not.toContain('value="0.1"');
		expect(body).not.toContain('value="0.2"');
		expect(body).toContain('>create<');
	});

	it('renders paused token jobs with activate and archive actions', () => {
		const { body } = render(BiddingAutomationPanel, {
			props: {
				open: true,
				chain: testChain(),
				collection: testCollection(),
				token: testToken(),
				job: testTokenJob(TRADING_JOB_STATUS.Paused),
				onClose: () => {},
				onJobChange: () => {}
			}
		});

		expect(body).toContain('>modify<');
		expect(body).toContain('>paused</span>');
		expect(body).toContain('>activate<');
		expect(body).toContain('>archive<');
		expect(body).not.toContain('>pause<');
		expect(body).toContain('disabled>modify<');
		expect(body).not.toContain('disabled>activate<');
		expect(body).not.toContain('disabled>archive<');
	});

	it('renders selected collection bid drafts as explicit collection jobs', () => {
		const draft = buildBiddingAutomationDraftFromBid({
			orderId: '0xcollection-bid',
			source: 'orders',
			materialization: {
				kind: 'market_bid',
				jobId: null,
				status: null,
				phase: null
			},
			scope: {
				kind: 'collection',
				label: 'collection',
				tokenId: null,
				traits: []
			},
			maker: {
				address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				isOwn: false
			},
			price: exactPrice('300000000000000000', '0.3'),
			quantity: '2',
			currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
			currencySymbol: 'WETH',
			protocolAddress: null,
			validUntil: 1_900_000_000,
			placedAt: '2026-01-02T00:00:00Z',
			snapshotRefreshedAtMs: null,
			seenAt: '2026-01-02T00:00:00Z',
			ownStatus: null
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

		expect(body).toContain('collection');
		expect(body).toContain('value="0.301"');
		expect(body).toContain('value="0.001"');
		expect(body).toContain('>create<');
		expect(body).not.toContain('not available');
	});

	it('renders tier-backed pricing as resolved floor and ceiling preview', () => {
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
						deltaEth: '0.01',
						pricingSource: {
							kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
							tierId: 'tier-base',
							tierName: 'base',
							resolvedAt: '2026-01-01T00:00:00Z',
							resolvedFloorWei: '100000000000000000',
							resolvedCeilingWei: '200000000000000000',
							deltaWei: '10000000000000000'
						}
					},
					runtime: null
				},
				priceTiers: [
					{
						tierId: 'tier-base',
						name: 'base',
						status: 'enabled',
						sortOrder: 0,
						parentTierId: null,
						floorConfig: {
							kind: 'fixed',
							valueEth: '0.12'
						},
						ceilingConfig: {
							kind: 'floor_delta',
							deltaKind: 'absolute',
							deltaEth: '0.03'
						},
						deltaEth: '0.01',
						resolvedFloorEth: '0.12',
						resolvedCeilingEth: '0.15',
						resolvedAt: '2026-01-02T00:00:00Z',
						lastError: null,
						revision: 2,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-02T00:00:00Z',
						archivedAt: null
					}
				],
				onClose: () => {}
			}
		});

		expect(body).toContain('bidding-automation-pricing-select');
		expect(body).toContain('>manual<');
		expect(body).toContain('>base<');
		expect(body).toContain('value="0.12"');
		expect(body).toContain('value="0.15"');
		expect(body).toContain('value="0.01"');
	});
});

function testChain() {
	return {
		id: 1,
		type: 'evm' as const,
		publicChainId: 1,
		slug: 'ethereum',
		name: 'Ethereum'
	};
}

function testCollection() {
	return {
		chainId: 1,
		collectionId: 1,
		slug: 'milady',
		address: '0x1111111111111111111111111111111111111111',
		standard: 'erc721' as const,
		status: 'live' as const,
		deploymentBlock: 1,
		bootstrapAnchorBlock: null,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

function testToken() {
	return {
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
	};
}

function testTokenJob(status: typeof TRADING_JOB_STATUS.Enabled | typeof TRADING_JOB_STATUS.Paused) {
	return {
		jobId: 'job-token-1',
		status,
		revision: 2,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T12:00:00Z',
		archivedAt: null,
		target: {
			type: 'token' as const,
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
			activeExpirationTimeMs: 1760000000000,
			bidPosition: null,
			bidConstraints: [],
			competitorPriceEth: null,
			lastRunAt: '2026-01-01T13:00:00Z',
			lastError: null,
			updatedAt: '2026-01-01T13:00:30Z'
		}
	};
}
