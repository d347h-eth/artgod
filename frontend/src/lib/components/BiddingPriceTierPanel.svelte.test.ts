import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import BiddingPriceTierPanel from './BiddingPriceTierPanel.svelte';

describe('BiddingPriceTierPanel', () => {
	it('renders collection price tiers and the compact create form', () => {
		const { body } = render(BiddingPriceTierPanel, {
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
				tiers: [
					{
						tierId: 'tier-root',
						name: 'base',
						status: 'enabled',
						sortOrder: 10,
						parentTierId: null,
						floorConfig: { kind: 'fixed', valueEth: '0.1' },
						ceilingConfig: { kind: 'fixed', valueEth: '0.2' },
						deltaEth: '0.001',
						resolvedFloorEth: '0.1',
						resolvedCeilingEth: '0.2',
						resolvedAt: '2026-01-02T00:00:00Z',
						lastError: null,
						revision: 1,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
						archivedAt: null
					},
					{
						tierId: 'tier-child',
						name: 'upper',
						status: 'paused',
						sortOrder: 20,
						parentTierId: 'tier-root',
						floorConfig: {
							kind: 'parent_delta',
							deltaKind: 'absolute',
							deltaEth: '0.01'
						},
						ceilingConfig: {
							kind: 'floor_delta',
							deltaKind: 'percent',
							percent: '10'
						},
						deltaEth: '0.002',
						resolvedFloorEth: '0.11',
						resolvedCeilingEth: '0.121',
						resolvedAt: '2026-01-02T00:00:00Z',
						lastError: 'resolution failed',
						revision: 2,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
						archivedAt: null
					}
				],
				settings: defaultBiddingCollectionSettings(),
				onSettingsChange: () => {},
				onTiersChange: () => {}
			}
		});

		expect(body).toContain('price tiers');
		expect(body).toContain('base');
		expect(body).toContain('upper');
		expect(body).toContain('0.1');
		expect(body).toContain('0.121');
		expect(body).toContain('resolution failed');
		expect(body).toContain('tier selector');
		expect(body).toContain('default delta ETH');
		expect(body).toContain('price delta ETH');
		expect(body).toContain('>reapply<');
		expect(body).toContain('<option value="" selected="">root</option>');
		expect(body).toContain('>create<');
		expect(body).not.toContain('status</span></label>');
		expect(body).not.toContain('bidding-price-tier-meta');
	});
});
