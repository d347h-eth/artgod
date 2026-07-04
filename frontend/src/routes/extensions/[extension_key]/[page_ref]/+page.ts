import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { loadCollectionExtensionPage } from '$lib/collection-extension-pages/page-load';
import { resolvePreferredCollectionMediaModeHref } from '$lib/media-mode-navigation-preferences';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionTokensPath
} from '$lib/runtime/public-deployment';

export const load: PageLoad = async ({ fetch, params, setHeaders, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}
	if (!PUBLIC_COLLECTION_SCOPE) {
		throw error(500, 'Public collection scope is not configured');
	}

	const preferredMediaHref = resolvePreferredCollectionMediaModeHref({
		url,
		scopePath: publicCollectionTokensPath()
	});
	if (preferredMediaHref) {
		throw redirect(307, preferredMediaHref);
	}

	return loadCollectionExtensionPage({
		fetch,
		setHeaders,
		chainRef: PUBLIC_COLLECTION_SCOPE.chainRef,
		collectionRef: PUBLIC_COLLECTION_SCOPE.collectionRef,
		extensionKey: params.extension_key,
		pageRef: params.page_ref,
		url,
		basePath: '/'
	});
};
