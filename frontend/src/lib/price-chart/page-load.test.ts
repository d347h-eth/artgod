import { afterEach, expect, it, vi } from 'vitest';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_QUERY_PARAMS,
	COLLECTION_MEDIA_PREFERENCE_VALUES
} from '@artgod/shared/extensions';
import {
	BackendApiError,
	getPriceChartContext,
	getRuntimeConfig,
	getCollectionDetail
} from '$lib/backend-api';
import { loadCollectionChartPage } from './page-load';
import {
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION,
	BIDDING_E2E_MEDIA
} from '$lib/e2e/bidding-automation-fixtures';

vi.mock('$lib/backend-api', async (importOriginal) => {
	const { BackendApiError } = await importOriginal<typeof import('$lib/backend-api')>();
	return {
		BackendApiError,
		getPriceChartContext: vi.fn(),
		getRuntimeConfig: vi.fn(),
		getCollectionDetail: vi.fn(() => {
			throw new Error('Unexpected token-grid request');
		})
	};
});
afterEach(() => vi.clearAllMocks());

it.each([false, true])(
	'loads only chart context and runtime settings (public=%s)',
	async (publicPage) => {
		const context = {
			chain: BIDDING_E2E_CHAIN,
			collection: { ...BIDDING_E2E_COLLECTION, slug: 'collection' },
			media: { ...BIDDING_E2E_MEDIA, selectedMode: COLLECTION_MEDIA_MODES.Snapshot },
			traits: {
				selected: [{ key: 'Mode', value: 'Terrain' }],
				selectedRanges: [{ key: 'Level', fromValue: '3', toValue: null }],
				facets: []
			}
		};
		const blockExplorer = { baseUrl: 'https://example.com' };
		vi.mocked(getPriceChartContext).mockResolvedValue(
			context as Awaited<ReturnType<typeof getPriceChartContext>>
		);
		vi.mocked(getRuntimeConfig).mockResolvedValue({ blockExplorer } as Awaited<
			ReturnType<typeof getRuntimeConfig>
		>);
		const fetchFn = vi.fn<typeof fetch>(async () => {
			throw new Error('Unexpected page fetch');
		});
		const query = new URLSearchParams({
			[COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference]: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
			trait: 'Mode:Terrain',
			trait_range: 'Level:3..',
			owner: 'unused',
			limit: '1'
		});
		expect(
			await loadCollectionChartPage(fetchFn, 'ethereum', 'collection', query, publicPage)
		).toEqual({
			chain: context.chain,
			collection: context.collection,
			media: context.media,
			selectedTraits: context.traits.selected,
			selectedTraitRanges: context.traits.selectedRanges,
			facets: context.traits.facets,
			blockExplorer,
			basePath: publicPage ? '/' : '/ethereum/collection'
		});
		expect(getPriceChartContext).toHaveBeenCalledExactlyOnceWith(
			fetchFn,
			'ethereum',
			'collection',
			new URLSearchParams({
				traits: 'Mode:Terrain',
				trait_ranges: 'Level:3..',
				[COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference]: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
			})
		);
		expect(getRuntimeConfig).toHaveBeenCalledExactlyOnceWith(fetchFn);
		expect(getCollectionDetail).not.toHaveBeenCalled();
		expect(fetchFn).not.toHaveBeenCalled();
	}
);

it('preserves a missing collection response for page recovery', async () => {
	vi.mocked(getPriceChartContext).mockRejectedValue(
		new BackendApiError('Collection not found', 404)
	);
	await expect(
		loadCollectionChartPage(vi.fn(), 'ethereum', 'missing', new URLSearchParams())
	).rejects.toMatchObject({ status: 404, body: { message: 'Collection not found' } });
});
