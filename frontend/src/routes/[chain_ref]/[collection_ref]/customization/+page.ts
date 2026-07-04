import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getCollectionCustomization } from '$lib/backend-api';
import {
	collectionMediaModePreferenceScope,
	resolvePreferredCollectionMediaModeHref
} from '$lib/media-mode-navigation-preferences';
import { normalizeMediaMode } from '$lib/media-mode';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { parseSelectedTraitRanges, parseSelectedTraits } from '$lib/trait-filters';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}

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

	const preferredMediaHref = resolvePreferredCollectionMediaModeHref({
		url,
		scopePath: collectionMediaModePreferenceScope({
			chainRef: params.chain_ref,
			collectionRef: params.collection_ref
		})
	});
	if (preferredMediaHref) {
		throw redirect(307, preferredMediaHref);
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
