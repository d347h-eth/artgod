import { error } from '@sveltejs/kit';
import { BackendApiError, getPriceChartContext, getRuntimeConfig } from '$lib/backend-api';
import { MEDIA_PREFERENCE_QUERY_PARAM } from '$lib/media-mode';

// The page loads only identity/media/navigation; sales retain independent recovery.
export async function loadCollectionChartPage(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	query: URLSearchParams,
	publicPage = false
) {
	const contextQuery = new URLSearchParams();
	const preference = query.get(MEDIA_PREFERENCE_QUERY_PARAM);
	if (preference) contextQuery.set(MEDIA_PREFERENCE_QUERY_PARAM, preference);
	try {
		const [context, runtime] = await Promise.all([
			getPriceChartContext(fetchFn, chainRef, collectionRef, contextQuery),
			getRuntimeConfig(fetchFn)
		]);
		return {
			chain: context.chain,
			collection: context.collection,
			media: context.media,
			basePath: publicPage ? '/' : '/' + context.chain.slug + '/' + context.collection.slug,
			blockExplorer: runtime.blockExplorer
		};
	} catch (cause) {
		if (cause instanceof BackendApiError) throw error(cause.status, cause.message);
		throw error(500, 'Could not load collection. Reload the page.');
	}
}
