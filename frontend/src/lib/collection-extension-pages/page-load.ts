import { error } from '@sveltejs/kit';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';
import { BackendApiError, getCollectionDetailWithHeaders } from '$lib/backend-api';
import type { CollectionExtensionPageRef } from '$lib/collection-extension-pages/types';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import {
	forwardQueryCacheResponseHeaders,
	type ResponseHeaderSetter
} from '$lib/query-cache-response-headers';

export type CollectionExtensionPageLoadResult = {
	chain: ApiChain | null;
	collection: ApiCollection | null;
	media: ApiCollectionMediaState;
	basePath: string;
	page: CollectionExtensionPageRef;
};

type CollectionExtensionPageLoadInput = {
	fetch: typeof fetch;
	setHeaders: ResponseHeaderSetter;
	chainRef: string;
	collectionRef: string;
	extensionKey: string;
	pageRef: string;
	url: URL;
	basePath?: string;
};

// Extension pages only need collection context; request one token to satisfy the existing API shape.
const COLLECTION_EXTENSION_PAGE_TOKEN_LIMIT = 1;

// Loads collection context required by a generic extension-owned page host.
export async function loadCollectionExtensionPage(
	input: CollectionExtensionPageLoadInput
): Promise<CollectionExtensionPageLoadResult> {
	const responseWithHeaders = await requestCollectionDetail(input);
	forwardQueryCacheResponseHeaders(input.setHeaders, responseWithHeaders.headers);
	const response = responseWithHeaders.payload;
	if (!collectionHasExtension(response.collection, input.extensionKey)) {
		throw error(404, 'Not found');
	}

	return {
		chain: response.chain,
		collection: response.collection,
		media: response.media,
		basePath: input.basePath ?? `/${response.chain.slug}/${response.collection.slug}`,
		page: {
			extensionKey: input.extensionKey,
			pageRef: input.pageRef
		}
	};
}

// Builds the empty shape used by admin/static shell routes before backend data is available.
export function emptyCollectionExtensionPageLoadResult(
	basePath: string,
	page: CollectionExtensionPageRef
): CollectionExtensionPageLoadResult {
	return {
		chain: null,
		collection: null,
		media: {
			selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
			defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableModes: [{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot }]
		},
		basePath,
		page
	};
}

async function requestCollectionDetail(input: CollectionExtensionPageLoadInput) {
	try {
		return await getCollectionDetailWithHeaders(
			input.fetch,
			input.chainRef,
			input.collectionRef,
			minimalCollectionExtensionPageQuery(input.url.searchParams)
		);
	} catch (cause) {
		toKitError(cause);
	}
}

function minimalCollectionExtensionPageQuery(raw: URLSearchParams): URLSearchParams {
	const query = new URLSearchParams();
	query.set('limit', String(COLLECTION_EXTENSION_PAGE_TOKEN_LIMIT));
	appendMediaModeParam(query, normalizeMediaMode(raw.get('media_mode')));
	return query;
}

function collectionHasExtension(collection: ApiCollection, extensionKey: string): boolean {
	return collection.extensions?.some((extension) => extension.key === extensionKey) ?? false;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
