import { error } from '@sveltejs/kit';
import { loadCollectionChartPage } from '$lib/price-chart/page-load';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';
import type { PageLoad } from './$types';
export const load: PageLoad = ({ fetch, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE)
		throw error(404, 'Not found');
	return loadCollectionChartPage(
		fetch,
		PUBLIC_COLLECTION_SCOPE.chainRef,
		PUBLIC_COLLECTION_SCOPE.collectionRef,
		url.searchParams,
		true
	);
};
