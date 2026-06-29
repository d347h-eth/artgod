import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_BOOK_SOURCE,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import type { ApiBiddingBidBook, ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import BidBookPanel from './BidBookPanel.svelte';

const BASE_BID: ApiBiddingBidBookRow = {
	orderId: '0xbase',
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
		address: '0x1111111111111111111111111111111111111111',
		label: '0x1111111111111111111111111111111111111111',
		isOwn: false
	},
	price: exactPrice('300000000000000000', '0.3'),
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
};

function exactPrice(wei: string, eth: string): ApiBiddingBidBookRow['price'] {
	return {
		kind: 'exact',
		wei,
		eth
	};
}

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
			ownMakerAddress: null,
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
					price: exactPrice('290000000000000000', '0.29'),
					maker: {
						address: '0x2222222222222222222222222222222222222222',
						label: '0x2222222222222222222222222222222222222222',
						isOwn: false
					}
				},
				{
					...BASE_BID,
					orderId: '0xtrait-low',
					price: exactPrice('300000000000000', '0.0003'),
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
					price: exactPrice('800000000000000000', '0.8')
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
					price: exactPrice('100000000000000000', '0.1')
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

	it('keeps own low bids visible and unmuted in row views', () => {
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 3,
				durationMs: null,
				lastError: null
			},
			ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			bids: [
				{
					...BASE_BID,
					orderId: '0xtop',
					scope: {
						kind: 'token',
						label: '#1',
						tokenId: '1',
						traits: []
					},
					price: exactPrice('1000000000000000000', '1')
				},
				{
					...BASE_BID,
					orderId: '0xown-low',
					scope: {
						kind: 'token',
						label: '#2',
						tokenId: '2',
						traits: []
					},
					maker: {
						address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						label: 'You',
						isOwn: true
					},
					price: exactPrice('10000000000000000', '0.01')
				},
				{
					...BASE_BID,
					orderId: '0xother-low',
					scope: {
						kind: 'token',
						label: '#3',
						tokenId: '3',
						traits: []
					},
					price: exactPrice('9000000000000000', '0.009')
				}
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				showScope: true
			}
		});

		expect(body).toMatch(/<tr class="bid-book-own-row">[\s\S]*data-open-sea-order-hash="0xown-low"/);
		expect(body).not.toContain('data-open-sea-order-hash="0xother-low"');
		expect(body).toContain('expand 1');
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
			ownMakerAddress: null,
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
					price: exactPrice('200000000000000000', '0.2')
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
					price: exactPrice('190000000000000000', '0.19')
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
					price: exactPrice('345000000000000', '0.000345')
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

	it('renders separate trait-demand filter and bid actions', () => {
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
			ownMakerAddress: null,
			bids: [BASE_BID]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				view: 'trait-demand',
				onFilterTraitDemandGroup: () => {},
				onSelectBid: () => {}
			}
		});

		const filterButtonIndex = body.indexOf('aria-label="filter');
		const bidIconIndex = body.indexOf('bid-book-place-bid-icon', filterButtonIndex);
		expect(body).toContain('filter-icon');
		expect(body).toContain('bid-book-place-bid-icon');
		expect(filterButtonIndex).toBeGreaterThanOrEqual(0);
		expect(bidIconIndex).toBeGreaterThan(filterButtonIndex);
	});

	it('omits redundant trait-demand filter actions for single trait buckets', () => {
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
			ownMakerAddress: null,
			bids: [
				{
					...BASE_BID,
					scope: {
						kind: 'trait',
						label: 'Biome=42',
						tokenId: null,
						traits: [{ type: 'Biome', value: '42' }]
					}
				}
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				view: 'trait-demand',
				onFilterTraitDemandGroup: () => {},
				onSelectBid: () => {}
			}
		});

		expect(body).not.toContain('filter-icon');
		expect(body).toContain('bid-book-place-bid-icon');
		expect(body).toContain('aria-label="place bid on Biome=42"');
	});

	it('uses maker filter links when provided', () => {
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
			ownMakerAddress: null,
			bids: [
				{
					...BASE_BID,
					orderId: '0xmaker-filter',
					scope: {
						kind: 'collection',
						label: 'collection',
						tokenId: null,
						traits: []
					}
				}
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact',
				makerFilterHref: (makerAddress: string) =>
					`/ethereum/terraforms/bidding?maker=${makerAddress}`,
				onSelectBid: () => {}
			}
		});

		expect(body).toContain(
			'href="/ethereum/terraforms/bidding?maker=0x1111111111111111111111111111111111111111"'
		);
		expect(body).toContain('>use</button>');
		expect(body).not.toContain('/holders/');
	});

	it('labels own bids and shows compact position and constraint badges', () => {
		const job: ApiBiddingJob = {
			jobId: 'job-token-1',
			status: TRADING_JOB_STATUS.Enabled,
			revision: 1,
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
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
			runtime: null
		};
		const ownBid = {
			...BASE_BID,
			orderId: '0xown-token',
			scope: {
				kind: 'token' as const,
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
			bidLimits: {
				floorWei: '100000000000000000',
				floorEth: '0.1',
				ceilingWei: '200000000000000000',
				ceilingEth: '0.2'
			},
			ownStatus: {
				position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning,
				constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
				job: {
					jobId: 'job-token-1',
					revision: 1,
					status: TRADING_JOB_STATUS.Enabled
				}
			}
		};
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 2,
				durationMs: null,
				lastError: null
			},
			ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			bids: [
				{
					...ownBid,
					price: exactPrice('190000000000000000', '0.19'),
					maker: {
						address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
						label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
						isOwn: false
					},
					ownStatus: null
				},
				ownBid
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				job,
				showScope: true,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('>You</a>');
		expect(body).toContain('title="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
		expect(body).toContain('bid-book-own-status-winning');
		expect(body).toContain('>winning</span>');
		expect(body).toContain('bid-book-own-status-ceiling');
		expect(body).toContain('>hit ceiling</span>');
		expect(body).toContain('>floor</th>');
		expect(body).toContain('>ceiling</th>');
		expect(body).toContain('>0.10</td>');
		expect(body).toContain('>0.20</td>');
	});

	it('shows runtime status for active own job intents', () => {
		const job: ApiBiddingJob = {
			jobId: 'job-token-1',
			status: TRADING_JOB_STATUS.Enabled,
			revision: 1,
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
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
			runtime: null
		};
		const activeIntent: ApiBiddingBidBookRow = {
			...BASE_BID,
			orderId: '0xruntime-order',
			materialization: {
				kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
				jobId: 'job-token-1',
				status: TRADING_JOB_STATUS.Enabled,
				phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued
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
			bidLimits: {
				floorWei: '100000000000000000',
				floorEth: '0.1',
				ceilingWei: '200000000000000000',
				ceilingEth: '0.2'
			},
			ownStatus: {
				position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
				constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
				job: {
					jobId: 'job-token-1',
					revision: 1,
					status: TRADING_JOB_STATUS.Enabled
				}
			}
		};
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 1,
				durationMs: null,
				lastError: null
			},
			ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			bids: [activeIntent]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				job,
				showScope: true,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('>You</a>');
		expect(body).toContain('bid-book-own-status-losing');
		expect(body).toContain('>losing</span>');
		expect(body).toContain('bid-book-own-status-ceiling');
		expect(body).toContain('>hit ceiling</span>');
		expect(body).not.toContain('>queued</span>');
		expect(body).toContain('>0.10</td>');
		expect(body).toContain('>0.20</td>');
	});

	it('shows queued for own job intents instead of computing a market position locally', () => {
		const job: ApiBiddingJob = {
			jobId: 'job-token-1',
			status: TRADING_JOB_STATUS.Enabled,
			revision: 1,
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
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
			runtime: null
		};
		const queuedIntent: ApiBiddingBidBookRow = {
			...BASE_BID,
			orderId: 'job-intent:job-token-1',
			materialization: {
				kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
				jobId: 'job-token-1',
				status: TRADING_JOB_STATUS.Enabled,
				phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued
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
			price: {
				kind: 'range',
				floorWei: '100000000000000000',
				floorEth: '0.1',
				ceilingWei: '200000000000000000',
				ceilingEth: '0.2'
			},
			bidLimits: {
				floorWei: '100000000000000000',
				floorEth: '0.1',
				ceilingWei: '200000000000000000',
				ceilingEth: '0.2'
			}
		};
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 2,
				durationMs: null,
				lastError: null
			},
			ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			bids: [
				{
					...BASE_BID,
					orderId: '0xopponent-token',
					scope: {
						kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
						label: '#1',
						tokenId: '1',
						traits: []
					},
					price: exactPrice('300000000000000000', '0.3')
				},
				queuedIntent
			]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				job,
				showScope: true,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('>state<');
		expect(body).toContain('>queued</span>');
		expect(body).not.toContain('>winning</span>');
		expect(body).not.toContain('outbid');
		expect(body).not.toContain('no active bid');
		expect(body).toContain('>floor</th>');
		expect(body).toContain('>ceiling</th>');
		expect(body).toContain('>0.10</td>');
		expect(body).toContain('>0.20</td>');
		expect(body).not.toContain('0.1-0.2');

		const { body: hiddenMetaBody } = render(BidBookPanel, {
			props: {
				bidBook,
				job,
				showScope: true,
				showOwnStateBadges: false,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(hiddenMetaBody).not.toContain('>state<');
		expect(hiddenMetaBody).toContain('>queued</span>');
	});

	it('shows cancellation phases for own job intents', () => {
		const cancelingIntent: ApiBiddingBidBookRow = {
			...BASE_BID,
			orderId: '0xcanceling',
			materialization: {
				kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
				jobId: 'job-token-1',
				status: TRADING_JOB_STATUS.Archived,
				phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling
			},
			maker: {
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				label: 'You',
				isOwn: true
			}
		};
		const failedIntent: ApiBiddingBidBookRow = {
			...cancelingIntent,
			orderId: '0xcancel-failed',
			materialization: {
				kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
				jobId: 'job-token-1',
				status: TRADING_JOB_STATUS.Archived,
				phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed
			}
		};
		const bidBook: ApiBiddingBidBook = {
			state: {
				source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
				updatedAt: null,
				snapshotRefreshedAtMs: null,
				projectedAt: null,
				rowCount: 2,
				durationMs: null,
				lastError: null
			},
			ownMakerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			bids: [cancelingIntent, failedIntent]
		};

		const { body } = render(BidBookPanel, {
			props: {
				bidBook,
				job: null,
				showScope: true,
				basePath: '/ethereum/terraforms',
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('bid-book-own-status-canceling');
		expect(body).toContain('>canceling</span>');
		expect(body).toContain('bid-book-own-status-cancel_failed');
		expect(body).toContain('>cancel failed</span>');
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
			ownMakerAddress: null,
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
