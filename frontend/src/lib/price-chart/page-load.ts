import { error } from '@sveltejs/kit';
import { BackendApiError, getCollectionDetail, getRuntimeConfig } from '$lib/backend-api';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { MEDIA_MODE_QUERY_PARAM, MEDIA_PREFERENCE_QUERY_PARAM } from '$lib/media-mode';

// Reuse the collection read contract for page identity/media/navigation. A single
// token is sufficient; the price request owns history loading and recovery.
export async function loadCollectionChartPage(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	query: URLSearchParams,
	publicPage = false
) {
	const contextQuery = new URLSearchParams({
		limit: '1',
		token_status: 'all',
		[MEDIA_MODE_QUERY_PARAM]: COLLECTION_MEDIA_MODES.Snapshot
	});
	const preference = query.get(MEDIA_PREFERENCE_QUERY_PARAM);
	if (preference) contextQuery.set(MEDIA_PREFERENCE_QUERY_PARAM, preference);
	try {
		const [context, runtime] = await Promise.all([
			getCollectionDetail(fetchFn, chainRef, collectionRef, contextQuery),
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
