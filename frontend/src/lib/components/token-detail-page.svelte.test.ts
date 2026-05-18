import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_EVENT_KEYS,
	TERRAFORMS_MODE_ATTRIBUTE_KEY,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import {
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_SCOPE_KIND
} from '@artgod/shared/types';
import { installBuiltInCollectionExtensions } from '$lib/collection-extension-built-ins';
import type { ApiBiddingBidBookRow } from '$lib/api-types';
import { TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS } from '$lib/activity-extension-views/terraforms/constants';
import TokenDetailPage from '../../routes/[chain_ref]/[collection_ref]/[token_ref]/+page.svelte';

installBuiltInCollectionExtensions();

function exactPrice(wei: string, eth: string): ApiBiddingBidBookRow['price'] {
	return {
		kind: 'exact',
		wei,
		eth
	};
}

function marketMaterialization(): ApiBiddingBidBookRow['materialization'] {
	return {
		kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
		jobId: null,
		status: null,
		phase: null
	};
}

describe('token detail page', () => {
	it('renders centered media with fallback title and traits table', () => {
		const { body } = render(TokenDetailPage, {
			props: {
				data: {
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
					traitFilterPresentation: {
						selectedSource: 'user',
						userConfig: { rangeKeys: ['Power'] },
						extensionConfig: null,
						effectiveConfig: { rangeKeys: ['Power'] },
						availableTraitKeys: ['Hat', 'Power']
					},
					token: {
						tokenId: '1',
						name: '',
						image: 'https://example.com/1.png',
						animationUrl: 'https://example.com/1.html',
						listingPrice: '500000000000000000',
						listingCurrency: '0x0000000000000000000000000000000000000000',
						currentHolder: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						attributes: [
							{
								key: 'Hat',
								value: 'Beanie',
								tokenCount: 2,
								rarityPercent: 66.6667
							},
							{
								key: 'Power',
								value: '7',
								tokenCount: 1,
								rarityPercent: 33.3333
							}
						],
						hasMetadata: true,
						metadataUpdatedAt: '2026-01-01T00:00:00Z'
						},
						tokenBiddingJob: null,
						tokenBiddingBidBook: {
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
										address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
										label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
										isOwn: false
									},
									price: exactPrice('100000000000000000', '0.1'),
									quantity: '1',
									currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
									currencySymbol: 'WETH',
									protocolAddress: null,
									validUntil: 4_000_000_000,
									placedAt: '2026-01-01T00:00:00Z',
									snapshotRefreshedAtMs: null,
									seenAt: '2026-01-01T00:00:00Z',
									ownStatus: null
								},
								{
									orderId: '0xtoken-bid',
									source: 'orders',
									materialization: marketMaterialization(),
									scope: {
										kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
										label: '#1',
										tokenId: '1',
										traits: []
									},
									maker: {
										address: '0xdddddddddddddddddddddddddddddddddddddddd',
										label: '0xdddddddddddddddddddddddddddddddddddddddd',
										isOwn: false
									},
									price: exactPrice('100000000000000000', '0.1'),
									quantity: '1',
									currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
									currencySymbol: 'WETH',
									protocolAddress: null,
									validUntil: 4_000_000_000,
									placedAt: '2026-01-01T00:00:00Z',
									snapshotRefreshedAtMs: null,
									seenAt: '2026-01-01T00:00:00Z',
									ownStatus: null
								},
								{
									orderId: '0xtrait-bid',
									source: 'orders',
									materialization: marketMaterialization(),
									scope: {
										kind: 'trait',
										label: 'Hat=Beanie',
										tokenId: null,
										traits: [{ type: 'Hat', value: 'Beanie' }]
									},
									maker: {
										address: '0xcccccccccccccccccccccccccccccccccccccccc',
										label: '0xcccccccccccccccccccccccccccccccccccccccc',
										isOwn: false
									},
									price: exactPrice('100000000000000000', '0.1'),
									quantity: '1',
									currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
									currencySymbol: 'WETH',
									protocolAddress: null,
									validUntil: 4_000_000_000,
									placedAt: '2026-01-01T00:00:00Z',
									snapshotRefreshedAtMs: null,
									seenAt: '2026-01-01T00:00:00Z',
									ownStatus: null
								}
							]
						},
						backPath: '/ethereum/milady',
						backQuery: 'cursor=opaque-cursor-token&token_status=listed&mode=grid&media_mode=artifact'
					}
			}
		});

		expect(body).toContain('back to collection');
		expect(body).toContain(
			'?cursor=opaque-cursor-token&amp;token_status=listed&amp;mode=grid&amp;media_mode=artifact'
		);
		expect(body).toContain('milady #1');
		expect(body).toContain('class="token-detail-media-frame"');
		expect(body).toContain('https://example.com/1.html');
		expect(body).toContain('aria-label="Token detail media mode"');
		expect(body).toContain('class="secondary-tab-active"');
		expect(body).toContain('>artifact<');
		expect(body).toContain('>snapshot<');
		expect(body).toContain('current holder:');
		expect(body).toContain('Beanie');
		expect(body).toContain('66.67%');
		expect(body).toContain(
			'/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?limit=250&amp;mode=grid&amp;token_status=listed_then_unlisted&amp;media_mode=artifact'
		);
		expect(body).toContain(
			'https://opensea.io/item/ethereum/0x1111111111111111111111111111111111111111/1'
		);
		expect(body).toContain('0.5 ETH [OS]');
		expect(body).toContain(
			'/ethereum/milady?limit=250&amp;mode=grid&amp;token_status=listed&amp;media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).not.toContain('traits=Power%3A7');
		expect(body).toContain('<th class="bid-book-col-center">scope</th>');
		expect(body).toContain('<span class="bid-book-scope-label">C</span>');
		expect(body).toContain('Hat=Beanie');
		expect(body).toContain('class="bid-book-demand-trait-list"');
		expect(body).toContain('class="bid-book-demand-trait-value-link"');
		expect(body).toContain('bid_scope=traits&amp;traits=Hat%3ABeanie');
		expect(body).toContain('filter-icon');
		expect(body).toContain('bid-book-place-bid-icon');
		expect(body).toContain('aria-label="place bid on #1"');
		expect(body).toContain('aria-label="place bid on collection"');
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=collection&amp;maker=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
		);
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;bid_scope=traits&amp;maker=0xcccccccccccccccccccccccccccccccccccccccc'
		);
		expect(body).toContain('role="region" aria-label="bidding automation"');
		expect(body).toContain('token bidding');
		expect(body).toContain('value="0.101"');
		expect(body).toContain('value="0.001"');
		expect(body).toContain('>create<');
		expect(body).not.toContain('>hide<');
		expect(body).not.toContain('>use<');
	});

	it('uses holder return path when provided', () => {
		const { body } = render(TokenDetailPage, {
			props: {
				data: {
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
					traitFilterPresentation: {
						selectedSource: 'user',
						userConfig: { rangeKeys: [] },
						extensionConfig: null,
						effectiveConfig: { rangeKeys: [] },
						availableTraitKeys: ['Hat']
					},
					token: {
						tokenId: '1',
						name: 'Milady #1',
						image: 'https://example.com/1.png',
						animationUrl: null,
						listingPrice: null,
						listingCurrency: null,
						currentHolder: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						attributes: [
							{
								key: 'Hat',
								value: 'Beanie',
								tokenCount: 2,
								rarityPercent: 66.6667
							}
						],
						hasMetadata: true,
						metadataUpdatedAt: '2026-01-01T00:00:00Z'
					},
					tokenBiddingJob: {
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
							lastRunAt: '2026-01-01T13:00:00Z',
							lastError: null,
							updatedAt: '2026-01-01T13:00:30Z'
						}
					},
					backPath: '/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					backQuery:
						'cursor=opaque-cursor-token&token_status=listed_then_unlisted&mode=grid&media_mode=artifact'
				}
			}
		});

		expect(body).toContain('back to holder');
		expect(body).toContain(
			'/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?cursor=opaque-cursor-token&amp;token_status=listed_then_unlisted&amp;mode=grid&amp;media_mode=artifact'
		);
		expect(body).toContain('srcdoc=');
		expect(body).not.toContain('token-detail-media-image');
		expect(body).toContain('aria-label="Token detail media mode"');
		expect(body).toContain('>[OS]<');
		expect(body).toContain(
			'/ethereum/milady?limit=250&amp;mode=grid&amp;token_status=listed&amp;media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain('token bidding');
		expect(body).toContain('value="0.1"');
		expect(body).toContain('value="0.2"');
		expect(body).toContain('value="0.01"');
		expect(body).toContain('>modify<');
	});

	it('keeps token-local lost mode out of collection navigation links', () => {
		const { body } = render(TokenDetailPage, {
			props: {
				data: {
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
						slug: 'terraforms',
						address: '0x1111111111111111111111111111111111111111',
						standard: 'erc721',
						status: 'live',
						deploymentBlock: 1,
						bootstrapAnchorBlock: null,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
						extensions: [{ key: TERRAFORMS_EXTENSION_KEY }]
					},
					media: {
						selectedMode: 'lost-terrain',
						defaultMode: 'artifact',
						availableModes: [
							{ key: 'artifact', label: 'artifact' },
							{ key: 'lost-terrain', label: 'lost' },
							{ key: 'snapshot', label: 'snapshot' }
						]
					},
					traitFilterPresentation: {
						selectedSource: 'user',
						userConfig: { rangeKeys: [] },
						extensionConfig: null,
						effectiveConfig: { rangeKeys: [] },
						availableTraitKeys: ['Mode']
					},
					token: {
						tokenId: '7710',
						name: 'Terraform #7710',
						image: 'https://example.com/lost.png',
						animationUrl: 'https://example.com/lost.html',
						listingPrice: null,
						listingCurrency: null,
						currentHolder: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						attributes: [
							{
								key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
								value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terraform,
								tokenCount: 1,
								rarityPercent: 100
							}
						],
						hasMetadata: true,
						metadataUpdatedAt: '2026-01-01T00:00:00Z'
					},
					tokenBiddingJob: null,
					backPath: null,
					backQuery: null
				}
			}
		});

		expect(body).toContain('>lost<');
		expect(body).toContain('secondary-tab-active');
		expect(body).toContain('/ethereum/terraforms?media_mode=artifact');
		expect(body).toContain(
			'/ethereum/terraforms/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?limit=250&amp;mode=grid&amp;token_status=listed_then_unlisted&amp;media_mode=artifact'
		);
		expect(body).toContain(
			`/ethereum/terraforms?limit=250&amp;mode=grid&amp;token_status=listed&amp;media_mode=artifact&amp;traits=${encodeURIComponent(
				`${TERRAFORMS_MODE_ATTRIBUTE_KEY}:${TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terraform}`
			)}`
		);
		expect(body).toContain(`${TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS.Dreams}:`);
		expect(body).toContain(TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS.FilterByToken);
		expect(body).toContain(
			`/ethereum/terraforms/activity?limit=250&amp;extension_event=${encodeURIComponent(
				`${TERRAFORMS_EXTENSION_KEY}:${TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed}`
			)}&amp;media_mode=artifact&amp;token_id=7710`
		);
		expect(body).not.toContain('media_mode=lost-terrain');
	});

	it('hides Terraforms dreams section for terrain tokens', () => {
		const { body } = render(TokenDetailPage, {
			props: {
				data: {
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
						slug: 'terraforms',
						address: '0x1111111111111111111111111111111111111111',
						standard: 'erc721',
						status: 'live',
						deploymentBlock: 1,
						bootstrapAnchorBlock: null,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
						extensions: [{ key: TERRAFORMS_EXTENSION_KEY }]
					},
					media: {
						selectedMode: 'artifact',
						defaultMode: 'artifact',
						availableModes: [{ key: 'artifact', label: 'artifact' }]
					},
					traitFilterPresentation: {
						selectedSource: 'user',
						userConfig: { rangeKeys: [] },
						extensionConfig: null,
						effectiveConfig: { rangeKeys: [] },
						availableTraitKeys: [TERRAFORMS_MODE_ATTRIBUTE_KEY]
					},
					token: {
						tokenId: '1',
						name: 'Terraform #1',
						image: 'https://example.com/1.png',
						animationUrl: null,
						listingPrice: null,
						listingCurrency: null,
						currentHolder: null,
						attributes: [
							{
								key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
								value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
								tokenCount: 1,
								rarityPercent: 100
							}
						],
						hasMetadata: true,
						metadataUpdatedAt: '2026-01-01T00:00:00Z'
					},
					tokenBiddingJob: null,
					backPath: null,
					backQuery: null
				}
			}
		});

		expect(body).not.toContain(`${TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS.Dreams}:`);
		expect(body).not.toContain(TERRAFORMS_TOKEN_DETAIL_SECTION_LABELS.FilterByToken);
	});

	it('uses bidding return path when opened from the collection bidding page', () => {
		const { body } = render(TokenDetailPage, {
			props: {
				data: {
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
					traitFilterPresentation: {
						selectedSource: 'user',
						userConfig: { rangeKeys: [] },
						extensionConfig: null,
						effectiveConfig: { rangeKeys: [] },
						availableTraitKeys: ['Hat']
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
					tokenBiddingJob: null,
					backPath: '/ethereum/milady/bidding',
					backQuery: 'media_mode=artifact'
				}
			}
		});

		expect(body).toContain('back to bidding');
		expect(body).toContain('/ethereum/milady/bidding?media_mode=artifact');
	});
	});
