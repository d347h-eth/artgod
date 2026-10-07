import { error, redirect } from '@sveltejs/kit';
import { loadCollectionChartPage } from '$lib/price-chart/page-load';
import { buildCollectionChartHref } from '$lib/price-chart/routing';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	matchesPublicCollectionRoute
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import type { PageLoad } from './$types';
export const load: PageLoad = ({ fetch, params, url }) => {
	if (IS_ADMIN_FRONTEND_TARGET) throw error(404, 'Not found');
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref))
			throw error(404, 'Not found');
		throw redirect(307, buildCollectionChartHref('/', undefined, url.searchParams));
	}
	return loadCollectionChartPage(fetch, params.chain_ref, params.collection_ref, url.searchParams);
};
