import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { SYNC_BACKFILL_CONTEXT_ANY } from '@artgod/shared/config/sync-backfill';
import { BackendApiError, getSyncBackfillState } from '$lib/backend-api';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			state: null,
			basePath: '/'
		};
	}

	const query = normalizeSyncBackfillParams(url.searchParams);
	try {
		const state = await getSyncBackfillState(fetch, params.chain_ref, query.apiParams);
		return {
			state,
			basePath: `/${state.chain.slug}/sync-backfill`,
			collection: query.collection,
			stack: query.stack
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeSyncBackfillParams(raw: URLSearchParams): {
	apiParams: URLSearchParams;
	collection: string;
	stack: string[];
} {
	const apiParams = new URLSearchParams();
	const collection = raw.get('collection')?.trim() || SYNC_BACKFILL_CONTEXT_ANY;
	apiParams.set('collection', collection);

	const stack = parsePageStack(raw.get('stack'));
	const activePage = stack.at(-1);
	if (activePage) {
		apiParams.set('page_start', String(activePage.pageStartBlock));
		apiParams.set('bucket_size', String(activePage.bucketSize));
	}

	return {
		apiParams,
		collection,
		stack: stack.map(formatPageStackEntry)
	};
}

function parsePageStack(raw: string | null): Array<{ pageStartBlock: number; bucketSize: number }> {
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
