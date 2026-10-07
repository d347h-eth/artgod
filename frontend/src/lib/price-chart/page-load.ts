import { error } from '@sveltejs/kit';
import { BackendApiError, getPriceChartContext, getRuntimeConfig } from '$lib/backend-api';
import { MEDIA_MODE_QUERY_PARAM, MEDIA_PREFERENCE_QUERY_PARAM } from '$lib/media-mode';
import { appendNormalizedTraitParams, appendNormalizedTraitRangeParams } from '$lib/trait-filters';

// Page context owns facets/navigation; sales retain independent loading and recovery.
export async function loadCollectionChartPage(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	query: URLSearchParams,
	publicPage = false
) {
	const contextQuery = new URLSearchParams();
	appendNormalizedTraitParams(contextQuery, query);
	appendNormalizedTraitRangeParams(contextQuery, query);
	const mode = query.get(MEDIA_MODE_QUERY_PARAM);
	if (mode) contextQuery.set(MEDIA_MODE_QUERY_PARAM, mode);
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
			selectedTraits: context.traits.selected,
			selectedTraitRanges: context.traits.selectedRanges,
			facets: context.traits.facets,
			basePath: publicPage ? '/' : '/' + context.chain.slug + '/' + context.collection.slug,
			blockExplorer: runtime.blockExplorer
		};
	} catch (cause) {
		if (cause instanceof BackendApiError) throw error(cause.status, cause.message);
		throw error(500, 'Could not load collection. Reload the page.');
	}
}
