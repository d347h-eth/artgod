import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
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
	const collection = raw.get('collection')?.trim() || 'any';
	apiParams.set('collection', collection);

	const stack = parseRangeStack(raw.get('stack'));
	const activeRange = stack.at(-1);
	if (activeRange) {
		apiParams.set('from_block', String(activeRange.fromBlock));
		apiParams.set('to_block', String(activeRange.toBlock));
	}

	return {
		apiParams,
		collection,
		stack: stack.map((range) => `${range.fromBlock}-${range.toBlock}`)
	};
}

function parseRangeStack(raw: string | null): Array<{ fromBlock: number; toBlock: number }> {
	if (!raw?.trim()) return [];
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [fromRaw, toRaw, extra] = entry.split('-');
			const fromBlock = Number(fromRaw);
			const toBlock = Number(toRaw);
			if (extra !== undefined || !Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
				throw error(400, 'Invalid range stack');
			}
			if (fromBlock < 0 || toBlock < fromBlock) {
				throw error(400, 'Invalid range stack');
			}
			return { fromBlock, toBlock };
		});
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
