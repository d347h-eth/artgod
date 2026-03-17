import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import BootstrapRunDetailView from './BootstrapRunDetailView.svelte';

describe('BootstrapRunDetailView', () => {
	it('renders the flow strip with metadata progress', () => {
		const { body } = render(BootstrapRunDetailView, {
			props: {
				chainRef: 'ethereum',
				runId: 7,
				initialDetail: {
					run: {
						runId: 7,
						chainId: 1,
						collectionId: 1,
						requestSlug: 'milady',
						requestAddress: '0x1111111111111111111111111111111111111111',
						requestOpenseaSlug: null,
						requestStandard: 'erc721',
						metadataMode: 'best_effort',
						enumerationMode: 'enumerable',
						manualTokenIdsJson: null,
						manualRangeStartTokenId: null,
						manualRangeTotalSupply: null,
						deploymentBlock: null,
						status: 'completed',
						anchorBlock: 24500000,
						anchorBlockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						anchorBlockTimestamp: 1726000000,
						errorCode: null,
						errorMessage: null,
						createdAt: '2026-02-01T00:00:00Z',
						updatedAt: '2026-02-01T00:02:00Z',
						finishedAt: '2026-02-01T00:02:00Z'
					},
					collection: {
						chainId: 1,
						collectionId: 1,
						slug: 'milady',
						address: '0x1111111111111111111111111111111111111111',
						status: 'live'
					},
					metadataTasks: {
						pending: 0,
						retry: 1,
						succeeded: 3,
						failedTerminal: 0,
						total: 4
					},
					flow: {
						steps: [
							{
								key: 'requested',
								label: 'requested',
								state: 'completed',
								detailText: null,
								progress: null
							},
							{
								key: 'metadata',
								label: 'metadata',
								state: 'active',
								detailText: 'retry 1',
								progress: {
									completed: 3,
									total: 4
								}
							},
							{
								key: 'opensea_ready',
								label: 'opensea ready',
								state: 'completed',
								detailText: null,
								progress: null
							}
						],
						isTerminal: false,
						shouldPoll: true
					},
					failedMetadataTasksPreview: [],
					failedMetadataTasksPreviewLimit: 50,
					isLatestForCollection: true
				}
			}
		});

		expect(body).toContain('bootstrap flow');
		expect(body).toContain('requested');
		expect(body).toContain('metadata');
		expect(body).toContain('3 / 4');
		expect(body).toContain('retry 1');
		expect(body).toContain('opensea ready');
	});

	it('suppresses opensea steps for non-latest runs', () => {
		const { body } = render(BootstrapRunDetailView, {
			props: {
				chainRef: 'ethereum',
				runId: 6,
				initialDetail: {
					run: {
						runId: 6,
						chainId: 1,
						collectionId: 1,
						requestSlug: 'milady',
						requestAddress: '0x1111111111111111111111111111111111111111',
						requestOpenseaSlug: null,
						requestStandard: 'erc721',
						metadataMode: 'best_effort',
						enumerationMode: 'enumerable',
						manualTokenIdsJson: null,
						manualRangeStartTokenId: null,
						manualRangeTotalSupply: null,
						deploymentBlock: null,
						status: 'completed',
						anchorBlock: 24500000,
						anchorBlockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						anchorBlockTimestamp: 1726000000,
						errorCode: null,
						errorMessage: null,
						createdAt: '2026-02-01T00:00:00Z',
						updatedAt: '2026-02-01T00:02:00Z',
						finishedAt: '2026-02-01T00:02:00Z'
					},
					collection: {
						chainId: 1,
						collectionId: 1,
						slug: 'milady',
						address: '0x1111111111111111111111111111111111111111',
						status: 'live'
					},
					metadataTasks: {
						pending: 0,
						retry: 0,
						succeeded: 4,
						failedTerminal: 0,
						total: 4
					},
					flow: {
						steps: [
							{
								key: 'requested',
								label: 'requested',
								state: 'completed',
								detailText: null,
								progress: null
							},
							{
								key: 'collection_live',
								label: 'collection live',
								state: 'completed',
								detailText: null,
								progress: null
							}
						],
						isTerminal: true,
						shouldPoll: false
					},
					failedMetadataTasksPreview: [],
					failedMetadataTasksPreviewLimit: 50,
					isLatestForCollection: false
				}
			}
		});

		expect(body).toContain('collection live');
		expect(body).not.toContain('opensea ready');
		expect(body).toContain('retry disabled for non-latest runs');
	});
});
