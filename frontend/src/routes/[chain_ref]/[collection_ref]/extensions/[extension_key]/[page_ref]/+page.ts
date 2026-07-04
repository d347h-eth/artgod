import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	emptyCollectionExtensionPageLoadResult,
	loadCollectionExtensionPage
} from '$lib/collection-extension-pages/page-load';
import {
	collectionMediaModePreferenceScope,
	resolvePreferredCollectionMediaModeHref
} from '$lib/media-mode-navigation-preferences';
import { withQuery } from '$lib/route-paths';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionExtensionPagePath
} from '$lib/runtime/public-deployment';

export const load: PageLoad = async ({ fetch, params, setHeaders, url }) => {
	const page = {
		extensionKey: params.extension_key,
		pageRef: params.page_ref
	};

	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(
			307,
			withQuery(publicCollectionExtensionPagePath(page.extensionKey, page.pageRef), url.searchParams)
		);
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return emptyCollectionExtensionPageLoadResult('/', page);
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

	return loadCollectionExtensionPage({
		fetch,
		setHeaders,
		chainRef: params.chain_ref,
		collectionRef: params.collection_ref,
		extensionKey: page.extensionKey,
		pageRef: page.pageRef,
		url
	});
};
