import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TokenDetailPage from '../../routes/[chain_ref]/[collection_ref]/[token_ref]/+page.svelte';

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
					token: {
						tokenId: '1',
						name: '',
						image: 'https://example.com/1.png',
						animationUrl: 'https://example.com/1.html',
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
					backCursor: 'opaque-cursor-token'
				}
			}
		});

		expect(body).toContain('back to collection');
		expect(body).toContain('?cursor=opaque-cursor-token');
		expect(body).toContain('milady #1');
		expect(body).toContain('https://example.com/1.html');
		expect(body).toContain('Beanie');
		expect(body).toContain('66.67%');
	});
});
