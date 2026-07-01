import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import {
	TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS,
	TERRAFORMS_BEACON_EVENT_GROUPS,
	TERRAFORMS_BEACON_EVENT_TYPES,
	TERRAFORMS_EVENT_RENDER_MODE_OPTIONS,
	TERRAFORMS_EXTENSION_EVENT_KEYS,
	TERRAFORMS_EXTENSION_EVENT_MEDIA_REFS,
	TERRAFORMS_EXTENSION_KEY
} from '@artgod/shared/extensions/terraforms';
import { installBuiltInCollectionExtensions } from '$lib/collection-extension-built-ins';
import CollectionActivitiesView from './CollectionActivitiesView.svelte';

installBuiltInCollectionExtensions();

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
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'snapshot', label: 'snapshot' }
					]
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
				facets: [
					{
						key: 'Hat',
						displayKind: 'set',
						minValue: null,
						maxValue: null,
						values: [{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }]
					}
				],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedTraitRanges: [],
				included: {
					hasTraitSummaryTemplate: true,
					eventMediaByActivityId: {},
					tokensById: {
						'1': {
							tokenId: '1',
							marketplaceBiddingSupported: true,
							name: 'Milady #1',
							image: 'https://example.com/1.png',
							traitSummary: 'L7/BForest/Alpha',
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
		expect(body).toContain('media');
		expect(body).toContain('name');
		expect(body).toContain('from');
		expect(body).toContain('to');
		expect(body).toContain('time');
		expect(body).toContain('asset events');
		expect(body).toContain('sales');
		expect(body).toContain('listings');
		expect(body).toContain('transfers');
		expect(body).toContain('Beanie');
		expect(body).toContain('class="activities-traits-col"');
		expect(body).toContain('>filter<');
		expect(body).toContain('>reset<');
		expect(body).toContain('>Hat=Beanie<');
		expect(body).toContain('relative');
		expect(body).toContain('<span class="runtime-tab-active">sales</span>');
		expect(body).not.toContain('Activity type filters');
		expect(body).toContain(
			'/ethereum/milady?limit=25&amp;mode=grid&amp;media_mode=artifact&amp;traits=Hat%3ABeanie&amp;token_status=listed'
		);
		expect(body).toContain(
			'/ethereum/milady/activity?limit=25&amp;kind=listings&amp;media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain(
			'/ethereum/milady/customization?media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain('/ethereum/milady/1?media_mode=artifact');
		expect(body).toContain('Milady #1');
		expect(body).toContain('https://example.com/1.png');
		expect(body).toContain('preview token 1');
		expect(body).toContain('0.5 ETH');
		expect(body).toContain('L7/BForest/Alpha');
		expect(body).toContain(
			'https://opensea.io/item/ethereum/0x1111111111111111111111111111111111111111/1'
		);
		expect(body).toContain('0x9999...9999');
		expect(body).toContain('0xaaaa...aaaa');
		expect(body).toContain(
			'/ethereum/milady/holders/0x9999999999999999999999999999999999999999?limit=250&amp;mode=grid&amp;token_status=listed_then_unlisted&amp;media_mode=artifact'
		);
		expect(body).toContain(
			'/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?limit=250&amp;mode=grid&amp;token_status=listed_then_unlisted&amp;media_mode=artifact'
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
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'snapshot', label: 'snapshot' }
					]
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
				facets: [
					{
						key: 'Hat',
						displayKind: 'set',
						minValue: null,
						maxValue: null,
						values: [{ value: 'Beanie', tokenCount: 1, marketplaceBiddingSupported: true }]
					}
				],
				selectedTraits: [],
				selectedTraitRanges: [],
				included: {
					hasTraitSummaryTemplate: false,
					eventMediaByActivityId: {},
					tokensById: {
						'1': {
							tokenId: '1',
							marketplaceBiddingSupported: true,
							name: 'Milady #1',
							image: 'https://example.com/1.png',
							traitSummary: null,
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
		expect(body).not.toContain('activities-traits-col');
		expect(body).not.toContain('>to<');
		expect(body).toContain('0x9999...9999');
		expect(body).toContain('class="activities-day-break-label">2024-09-10 UTC</span>');
	});

	it('renders Terraforms dreams rows with extension-owned maker and heightmap cells', () => {
		const maker = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
		const contentHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
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
					collectionId: 7,
					slug: 'terraforms',
					address: '0x4e1f41613c9084fdb9e34e11fae9412427480e56',
					standard: 'erc721',
					status: 'live',
					deploymentBlock: 1,
					bootstrapAnchorBlock: null,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z',
					activityEventFeeds: [
						{
							extensionKey: TERRAFORMS_EXTENSION_KEY,
							eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
							label: 'dreams',
							filters: {
								tokenId: { label: 'token' },
								maker: { label: 'maker' },
								contentHash: { label: 'canvas hash' }
							}
						}
					]
				},
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'snapshot', label: 'snapshot' }
					]
				},
				activities: {
					items: [
						{
							id: 33,
							scopeKind: 'token',
							kind: 'custom',
							contract: '0x4e1f41613c9084fdb9e34e11fae9412427480e56',
							tokenId: '7710',
							occurredAt: 1726100100,
							sourceKind: 'extension',
							sourceName: TERRAFORMS_EXTENSION_KEY,
							orderId: null,
							blockNumber: 22010001,
							txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
							logIndex: 8,
							from: null,
							to: null,
							maker,
							taker: null,
							side: null,
							amount: null,
							price: null,
							currency: null,
							payload: {
								eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
								contentHash,
								canvasRows: Array.from({ length: 16 }, (_, index) => String(index + 1))
							},
							isCollapsed: false,
							collapsedEventCount: null,
							collapsedWindowStartUtc: null,
							collapsedWindowEndUtc: null
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
				facets: [],
				selectedTraits: [],
				selectedTraitRanges: [],
				included: {
					hasTraitSummaryTemplate: true,
					eventMediaByActivityId: {
						'33': {
							image: 'data:image/svg+xml;base64,event-canvas',
							animationUrl: null,
							mediaRef: TERRAFORMS_EXTENSION_EVENT_MEDIA_REFS.TerraformedPreview,
							renderModes: [...TERRAFORMS_EVENT_RENDER_MODE_OPTIONS]
						}
					},
					tokensById: {
						'7710': {
							tokenId: '7710',
							marketplaceBiddingSupported: true,
							name: 'Terraform #7710',
							image: 'https://example.com/7710.png',
							traitSummary: 'L7/B12/Zone',
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					}
				},
				basePath: '/ethereum/terraforms',
				filterKind: null,
				extensionEvent: {
					extensionKey: TERRAFORMS_EXTENSION_KEY,
					eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed
				},
				activityFilters: {
					tokenId: null,
					maker: null,
					contentHash,
					eventGroup: null
				}
			}
		});

		expect(body).toContain('<span class="runtime-tab-active">dreams</span>');
		expect(body).toContain('asset events');
		expect(body).toContain('Hypercastle events');
		expect(body).not.toContain('extension events');
		expect(body).toContain('<th class="activities-media-col"><!--[!-->media');
		expect(body).toContain('<th class="activities-content-col"><!--[!-->heightmap');
		expect(body).toContain('/ethereum/terraforms/7710?media_mode=artifact');
		expect(body).toContain('filter token 7710');
		expect(body).toContain('token_id=7710');
		expect(body).toContain('filter-icon');
		expect(body).toContain('Terraform #7710');
		expect(body).toContain('L7/B12/Zone');
		expect(body).toContain('data:image/svg+xml;base64,event-canvas');
		expect(body).toContain('0xbbbb...bbbb');
		expect(body).toContain(`maker=${maker}`);
		expect(body).toContain('abcdef12');
		expect(body).toContain(`content_hash=${contentHash}`);
		expect(body).toContain('copy heightmap');
		expect(body).toContain('copy-icon');
		expect(body).toContain('activity-extension-filter-row');
		expect(body).toContain('terraforms-dreams-filter-input');
		expect(body).toContain('terraforms-dreams-submit-button');
		expect(body).not.toContain('terraforms-heightmap-filter-button');
		expect(body).not.toContain('canvas hash');
		expect(body).not.toContain('activity-extension-filter-input-hash');
	});

	it('renders Terraforms beacon rows with extension-owned action and group filters', () => {
		const maker = '0xcccccccccccccccccccccccccccccccccccccccc';
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
					collectionId: 7,
					slug: 'terraforms',
					address: '0x4e1f41613c9084fdb9e34e11fae9412427480e56',
					standard: 'erc721',
					status: 'live',
					deploymentBlock: 1,
					bootstrapAnchorBlock: null,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z',
					activityEventFeeds: [
						{
							extensionKey: TERRAFORMS_EXTENSION_KEY,
							eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
							label: 'dreams',
							filters: {}
						},
						{
							extensionKey: TERRAFORMS_EXTENSION_KEY,
							eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
							label: 'beacon',
							filters: {
								tokenId: { label: 'token' },
								maker: { label: 'maker' },
								eventGroup: {
									label: 'type',
									options: [...TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS]
								}
							}
						}
					]
				},
				media: {
					selectedMode: 'artifact',
					defaultMode: 'artifact',
					availableModes: [
						{ key: 'artifact', label: 'artifact' },
						{ key: 'snapshot', label: 'snapshot' }
					]
				},
				activities: {
					items: [
						{
							id: 44,
							scopeKind: 'token',
							kind: 'custom',
							contract: '0x331512a28a4cf80221af949b5d43041ff0fc7f01',
							tokenId: '7710',
							occurredAt: 1726100200,
							sourceKind: 'extension',
							sourceName: TERRAFORMS_EXTENSION_KEY,
							orderId: null,
							blockNumber: 22010002,
							txHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
							logIndex: 9,
							from: null,
							to: null,
							maker,
							taker: null,
							side: null,
							amount: null,
							price: null,
							currency: null,
							payload: {
								eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
								eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.ParcelModified,
								eventType: TERRAFORMS_BEACON_EVENT_TYPES.ParcelModified,
								modification: 1,
								modificationLabel: 'antenna on'
							},
							isCollapsed: false,
							collapsedEventCount: null,
							collapsedWindowStartUtc: null,
							collapsedWindowEndUtc: null
						},
						{
							id: 45,
							scopeKind: 'collection',
							kind: 'custom',
							contract: '0x331512a28a4cf80221af949b5d43041ff0fc7f01',
							tokenId: null,
							occurredAt: 1726100100,
							sourceKind: 'extension',
							sourceName: TERRAFORMS_EXTENSION_KEY,
							orderId: null,
							blockNumber: 22010001,
							txHash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
							logIndex: 8,
							from: null,
							to: null,
							maker,
							taker: null,
							side: null,
							amount: null,
							price: null,
							currency: null,
							payload: {
								eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
								eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
								eventType: TERRAFORMS_BEACON_EVENT_TYPES.BroadcastAdded,
								eventLabel: 'Broadcast Added',
								satellite: '0x7777777777777777777777777777777777777777',
								duration: '3600'
							},
							isCollapsed: false,
							collapsedEventCount: null,
							collapsedWindowStartUtc: null,
							collapsedWindowEndUtc: null
						}
					],
					prevCursor: null,
					nextCursor: null,
					limit: 25,
					totalItems: 2,
					rangeStart: 1,
					rangeEnd: 2,
					currentPage: 1,
					totalPages: 1
				},
				facets: [],
				selectedTraits: [],
				selectedTraitRanges: [],
				included: {
					hasTraitSummaryTemplate: true,
					eventMediaByActivityId: {},
					tokensById: {
						'7710': {
							tokenId: '7710',
							marketplaceBiddingSupported: true,
							name: 'Terraform #7710',
							image: 'https://example.com/7710.png',
							traitSummary: 'L7/B12/Zone',
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					}
				},
				basePath: '/ethereum/terraforms',
				filterKind: null,
				extensionEvent: {
					extensionKey: TERRAFORMS_EXTENSION_KEY,
					eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon
				},
				activityFilters: {
					tokenId: null,
					maker: null,
					contentHash: null,
					eventGroup: null
				}
			}
		});

		expect(body).toContain('<span class="runtime-tab-active">beacon</span>');
		expect(body).toContain('<th class="activities-terraforms-beacon-action-col"><!--[!-->action');
		expect(body).toContain('antenna on');
		expect(body).toContain('Broadcast Added');
		expect(body).toContain('<th class="activities-content-col"><!--[!-->details');
		expect(body).toContain('satellite <a href=');
		expect(body).toContain('0x7777...7777</a>');
		expect(body).toContain('/ duration 3600');
		expect(body).toContain(
			'https://etherscan.io/address/0x7777777777777777777777777777777777777777'
		);
		expect(body).not.toContain('enum 1');
		expect(body).toContain(`maker=${maker}`);
		expect(body).toContain('terraforms-beacon-filter-input');
		expect(body).toContain('Parcel Modified');
		expect(body).toContain(`value="${TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles}"`);
	});
});
