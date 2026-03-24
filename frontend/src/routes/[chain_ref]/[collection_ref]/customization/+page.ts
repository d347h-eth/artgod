import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getCollectionCustomization } from '$lib/backend-api';
import { normalizeMediaMode } from '$lib/media-mode';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { parseSelectedTraitRanges, parseSelectedTraits } from '$lib/trait-filters';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			customization: null,
			basePath: '/',
			selectedTraits: parseSelectedTraits(url.searchParams),
			selectedTraitRanges: parseSelectedTraitRanges(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get('media_mode'))
		};
	}

	try {
		const response = await getCollectionCustomization(fetch, params.chain_ref, params.collection_ref);
		return {
			chain: response.chain,
			collection: response.collection,
			customization: response.customization,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
			selectedTraits: parseSelectedTraits(url.searchParams),
			selectedTraitRanges: parseSelectedTraitRanges(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get('media_mode'))
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
