import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import BiddingPriceTierReapplyPreview from './BiddingPriceTierReapplyPreview.svelte';

describe('BiddingPriceTierReapplyPreview', () => {
	it('renders staged before and after prices for selected tier-backed jobs', () => {
		const { body } = render(BiddingPriceTierReapplyPreview, {
			props: {
				jobs: [
					{
						job: {
							jobId: 'job-1',
							status: 'enabled',
							revision: 1,
							createdAt: '2026-01-01T00:00:00Z',
							updatedAt: '2026-01-01T00:00:00Z',
							archivedAt: null,
							target: {
								type: 'token',
								tokenId: '123'
							},
							config: {
								floorEth: '0.1',
								ceilingEth: '0.2',
								deltaEth: '0.01',
								pricingSource: null
							},
							runtime: null
						},
						before: {
							floorEth: '0.1',
							ceilingEth: '0.2',
							deltaEth: '0.01',
							pricingSource: null
						},
						after: {
							floorEth: '0.12',
							ceilingEth: '0.22',
							deltaEth: '0.01',
							pricingSource: {
								kind: 'price_tier',
								tierId: 'tier-1',
								tierName: 'base',
								resolvedAt: '2026-01-02T00:00:00Z',
								resolvedFloorWei: '120000000000000000',
								resolvedCeilingWei: '220000000000000000',
								deltaWei: '10000000000000000'
							}
						},
						changed: true
					}
				],
				selectedJobIds: ['job-1'],
				onToggleJob: () => {},
				onApply: () => {}
			}
		});

		expect(body).toContain('affected');
		expect(body).toContain('#123');
		expect(body).toContain('0.1 -> 0.12');
		expect(body).toContain('0.2 -> 0.22');
		expect(body).toContain('>apply<');
	});
});
