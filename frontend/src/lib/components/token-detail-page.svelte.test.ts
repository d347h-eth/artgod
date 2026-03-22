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
					media: {
						selectedMode: 'artifact',
						defaultMode: 'artifact',
						availableModes: [
							{ key: 'artifact', label: 'artifact' },
							{ key: 'truth', label: 'truth' }
						]
					},
					token: {
						tokenId: '1',
						name: '',
						image: 'https://example.com/1.png',
						animationUrl: 'https://example.com/1.html',
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
		expect(body).toContain('https://example.com/1.html');
		expect(body).toContain('class="token-preview-media-mode-button"');
		expect(body).toContain('>artifact<');
		expect(body).toContain('Beanie');
		expect(body).toContain('66.67%');
		expect(body).toContain(
			'/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?limit=250&amp;mode=grid&amp;token_status=listed_then_unlisted&amp;media_mode=artifact'
		);
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
							{ key: 'truth', label: 'truth' }
						]
					},
					token: {
						tokenId: '1',
						name: 'Milady #1',
						image: 'https://example.com/1.png',
						animationUrl: null,
						currentHolder: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						attributes: [],
						hasMetadata: true,
						metadataUpdatedAt: '2026-01-01T00:00:00Z'
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
	});
});
