import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CollectionDetailView from './CollectionDetailView.svelte';

describe('CollectionDetailView', () => {
	it('renders token rows and trait facets', () => {
		const { body } = render(CollectionDetailView, {
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
				tokens: {
					items: [
						{
							tokenId: '1',
							name: 'Milady #1',
							image: 'https://example.com/1.png',
							traitSummary: 'L7/BForest/Alpha',
							listingPrice: '500000000000000000',
							listingCurrency: '0x0000000000000000000000000000000000000000',
							attributes: [{ key: 'Hat', value: 'Beanie' }],
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
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
						values: [{ value: 'Beanie', tokenCount: 1 }]
					}
				],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				selectedTraitRanges: [],
				basePath: '/ethereum/milady',
				requestCursor: null,
				tokenStatus: 'listed',
				displayMode: 'grid'
			}
		});

		expect(body).toContain('tokens');
		expect(body).toContain(
			'/ethereum/milady/activity?limit=25&amp;kind=sales&amp;media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain(
			'/ethereum/milady/customization?media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain(
			'/ethereum/milady/bidding?media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain('only listed');
		expect(body).toContain('show all');
		expect(body).toContain(
			'/ethereum/milady?limit=25&amp;mode=grid&amp;token_status=all&amp;media_mode=artifact&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain('<span class="runtime-tab-active">tokens</span>');
		expect(body).toContain('placeholder="jump to token #/owner/.eth"');
		expect(body).toContain('<span class="secondary-tab-active">artifact</span>');
		expect(body).toContain(
			'/ethereum/milady?limit=25&amp;mode=grid&amp;token_status=listed&amp;media_mode=snapshot&amp;traits=Hat%3ABeanie'
		);
		expect(body).toContain('>filter<');
		expect(body).toContain('>reset<');
		expect(body).toContain('>Hat=Beanie<');
		expect(body).toContain('1 listed');
		expect(body).toContain('token 1');
		expect(body).toContain(
			'/ethereum/milady/1?media_mode=artifact&amp;returnPath=%2Fethereum%2Fmilady&amp;returnQuery=limit%3D25%26mode%3Dgrid%26token_status%3Dlisted%26media_mode%3Dartifact%26traits%3DHat%253ABeanie'
		);
		expect(body).toContain('0.5 ETH');
		expect(body).toContain(
			'https://opensea.io/item/ethereum/0x1111111111111111111111111111111111111111/1'
		);
		expect(body).toContain('L7/BForest/Alpha');
		expect(body).toContain('Beanie');
	});
});
