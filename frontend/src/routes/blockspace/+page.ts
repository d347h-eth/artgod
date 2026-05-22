import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	BackendApiError,
	getBlockspaceStateWithHeaders,
	getCollectionDetailWithHeaders
} from '$lib/backend-api';
import { forwardQueryCacheResponseHeaders } from '$lib/query-cache-response-headers';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionBlockspacePath
} from '$lib/runtime/public-deployment';
import {
	buildBlockspaceStackStateApiParams,
	buildBlockspaceVisibleLevels,
	buildBlockspaceVisibleStackPagesFromEntries,
	formatBlockspacePageStackEntry,
	parseBlockspacePageStack,
	type BlockspacePageStackEntry
} from '$lib/blockspace-page-stack';

export const load: PageLoad = async ({ fetch, setHeaders, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}
	if (!PUBLIC_COLLECTION_SCOPE) {
		throw error(500, 'Public collection scope is not configured');
	}
	const publicScope = PUBLIC_COLLECTION_SCOPE;

	const query = normalizePublicBlockspaceParams(url.searchParams);
	try {
		// Fetch the public collection's visible blockspace path without exposing other contexts.
		const [stateResponses, collectionResponseWithHeaders] = await Promise.all([
			Promise.all(
				buildBlockspaceStackStateApiParams(
					publicScope.collectionRef,
					buildBlockspaceVisibleStackPagesFromEntries(query.stackPages)
				).map((apiParams) =>
					getBlockspaceStateWithHeaders(fetch, publicScope.chainRef, apiParams)
				)
			),
			getCollectionDetailWithHeaders(
				fetch,
				publicScope.chainRef,
				publicScope.collectionRef,
				minimalCollectionQuery()
			)
		]);
		const primaryStateResponse = stateResponses.at(-1);
		if (primaryStateResponse) {
			forwardQueryCacheResponseHeaders(setHeaders, primaryStateResponse.headers);
		} else {
			forwardQueryCacheResponseHeaders(setHeaders, collectionResponseWithHeaders.headers);
		}
		const states = stateResponses.map((response) => response.payload);
		const collectionResponse = collectionResponseWithHeaders.payload;
		const state = states.at(-1) ?? null;
		if (!state) {
			throw error(500, 'Backend request failed');
		}
		return {
			state,
			levels: buildBlockspaceVisibleLevels(query.stack, states),
			basePath: publicCollectionBlockspacePath(),
			collection: publicScope.collectionRef,
			collectionDetail: collectionResponse.collection,
			stack: query.stack
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizePublicBlockspaceParams(raw: URLSearchParams): {
	stack: string[];
	stackPages: BlockspacePageStackEntry[];
} {
	const stack = parseBlockspacePageStack(raw.get('stack'));
	if (!stack) {
		throw error(400, 'Invalid page stack');
	}

	return {
		stack: stack.map(formatBlockspacePageStackEntry),
		stackPages: stack
	};
}

function minimalCollectionQuery(): URLSearchParams {
	const params = new URLSearchParams();
	params.set('limit', '1');
	return params;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
