import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { buildBiddingE2eCollectionDetailData } from '$lib/e2e/bidding-automation-fixtures';
import { getDefaultBlockExplorerConfig } from '@artgod/shared/config/block-explorer';
import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types/customization';
import type { PageLoad } from './$types';
export const ssr = false;
export const load: PageLoad = ({ url }) => {
	if (!dev) throw error(404, 'Not found');
	const data = buildBiddingE2eCollectionDetailData(url.searchParams);
	return {
		...data,
		// Exercise the same numeric presentation supplied by collection customization.
		facets: data.facets.map((facet) =>
			facet.key === 'Biome'
				? {
						...facet,
						displayKind: TRAIT_FILTER_DISPLAY_KIND.Range,
						minValue: '7',
						maxValue: '42',
						values: []
					}
				: facet
		),
		blockExplorer: getDefaultBlockExplorerConfig()
	};
};
