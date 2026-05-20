import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { SYNC_BACKFILL_CONTEXT_ANY } from '@artgod/shared/config/sync-backfill';
import { BackendApiError, getSyncBackfillState } from '$lib/backend-api';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import type { SyncBackfillStateApiResponse } from '$lib/api-types';
import type { SyncBackfillVisibleLevel } from '$lib/sync-backfill-isometric-levels';

type PageStackEntry = {
	pageStartBlock: number;
	bucketSize: number;
};

export const load: PageLoad = async ({ fetch, params, url }) => {
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
			levels: buildVisibleLevels(query.stack, states),
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
	stackPages: PageStackEntry[];
} {
	const collection = raw.get('collection')?.trim() || SYNC_BACKFILL_CONTEXT_ANY;
	const stack = parsePageStack(raw.get('stack'));

	return {
		collection,
		stack: stack.map(formatPageStackEntry),
		stackPages: stack
	};
}

function buildVisibleLevelRequests(
	collection: string,
	stackPages: PageStackEntry[]
): Array<{ apiParams: URLSearchParams }> {
	return [
		{ apiParams: buildStateApiParams(collection, null) },
		...stackPages.map((page) => ({ apiParams: buildStateApiParams(collection, page) }))
	];
}

function buildStateApiParams(collection: string, page: PageStackEntry | null): URLSearchParams {
	const apiParams = new URLSearchParams();
	apiParams.set('collection', collection);
	if (page) {
		apiParams.set('page_start', String(page.pageStartBlock));
		apiParams.set('bucket_size', String(page.bucketSize));
	}
	return apiParams;
}

function buildVisibleLevels(
	stack: string[],
	states: SyncBackfillStateApiResponse[]
): SyncBackfillVisibleLevel[] {
	return states.map((state, index) => ({
		key: index === 0 ? 'root' : `L${index}:${stack[index - 1]}`,
		label: index === 0 ? 'root' : `L${index}`,
		stack: stack.slice(0, index),
		state
	}));
}

function parsePageStack(raw: string | null): PageStackEntry[] {
	if (!raw?.trim()) return [];
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [pageStartRaw, bucketSizeRaw, extra] = entry.split(':');
			const pageStartBlock = Number(pageStartRaw);
			const bucketSize = Number(bucketSizeRaw);
			if (
				extra !== undefined ||
				!Number.isInteger(pageStartBlock) ||
				!Number.isInteger(bucketSize)
			) {
				throw error(400, 'Invalid page stack');
			}
			if (pageStartBlock < 0 || bucketSize <= 0) {
				throw error(400, 'Invalid page stack');
			}
			return { pageStartBlock, bucketSize };
		});
}

function formatPageStackEntry(page: { pageStartBlock: number; bucketSize: number }): string {
	return `${page.pageStartBlock}:${page.bucketSize}`;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
