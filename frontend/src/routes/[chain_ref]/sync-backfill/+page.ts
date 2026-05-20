import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { SYNC_BACKFILL_CONTEXT_ANY } from '@artgod/shared/config/sync-backfill';
import { BackendApiError, getSyncBackfillState } from '$lib/backend-api';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { SYNC_BACKFILL_LIVE_INVALIDATION_KEY } from '$lib/sync-backfill-live-refresh';
import {
	buildSyncBackfillStateApiParams,
	buildSyncBackfillVisibleLevels,
	formatSyncBackfillPageStackEntry,
	parseSyncBackfillPageStack,
	type SyncBackfillPageStackEntry
} from '$lib/sync-backfill-page-stack';

export const load: PageLoad = async ({ depends, fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			state: null,
			levels: [],
			basePath: '/'
		};
	}

	depends(SYNC_BACKFILL_LIVE_INVALIDATION_KEY);
	const query = normalizeSyncBackfillParams(url.searchParams);
	try {
		// Fetch each visible path page so the renderer can stack the current navigation branch.
		const states = await Promise.all(
			buildVisibleLevelRequests(query.collection, query.stackPages).map((request) =>
				getSyncBackfillState(fetch, params.chain_ref, request.apiParams)
			)
		);
		const state = states.at(-1) ?? null;
		if (!state) {
			throw error(500, 'Backend request failed');
		}
		return {
			state,
			levels: buildSyncBackfillVisibleLevels(query.stack, states),
			basePath: `/${state.chain.slug}/sync-backfill`,
			collection: query.collection,
			stack: query.stack
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeSyncBackfillParams(raw: URLSearchParams): {
	collection: string;
	stack: string[];
	stackPages: SyncBackfillPageStackEntry[];
} {
	const collection = raw.get('collection')?.trim() || SYNC_BACKFILL_CONTEXT_ANY;
	const stack = parseSyncBackfillPageStack(raw.get('stack'));
	if (!stack) {
		throw error(400, 'Invalid page stack');
	}

	return {
		collection,
		stack: stack.map(formatSyncBackfillPageStackEntry),
		stackPages: stack
	};
}

function buildVisibleLevelRequests(
	collection: string,
	stackPages: SyncBackfillPageStackEntry[]
): Array<{ apiParams: URLSearchParams }> {
	return [
		{ apiParams: buildSyncBackfillStateApiParams(collection, null) },
		...stackPages.map((page) => ({
			apiParams: buildSyncBackfillStateApiParams(collection, page)
		}))
	];
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
