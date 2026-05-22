import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getCollectionDetail, getSyncBackfillState } from '$lib/backend-api';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionBlockspacePath
} from '$lib/runtime/public-deployment';
import {
	buildSyncBackfillStackStateApiParams,
	buildSyncBackfillVisibleLevels,
	buildSyncBackfillVisibleStackPagesFromEntries,
	formatSyncBackfillPageStackEntry,
	parseSyncBackfillPageStack,
	type SyncBackfillPageStackEntry
} from '$lib/sync-backfill-page-stack';

export const load: PageLoad = async ({ fetch, url }) => {
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
		const [states, collectionResponse] = await Promise.all([
			Promise.all(
				buildSyncBackfillStackStateApiParams(
					publicScope.collectionRef,
					buildSyncBackfillVisibleStackPagesFromEntries(query.stackPages)
				).map((apiParams) =>
					getSyncBackfillState(fetch, publicScope.chainRef, apiParams)
				)
			),
			getCollectionDetail(
				fetch,
				publicScope.chainRef,
				publicScope.collectionRef,
				minimalCollectionQuery()
			)
		]);
		const state = states.at(-1) ?? null;
		if (!state) {
			throw error(500, 'Backend request failed');
		}
		return {
			state,
			levels: buildSyncBackfillVisibleLevels(query.stack, states),
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
	stackPages: SyncBackfillPageStackEntry[];
} {
	const stack = parseSyncBackfillPageStack(raw.get('stack'));
	if (!stack) {
		throw error(400, 'Invalid page stack');
	}

	return {
		stack: stack.map(formatSyncBackfillPageStackEntry),
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
