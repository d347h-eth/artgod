import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getTokenDetail } from '$lib/backend-api';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const backQuery = normalizeReturnQuery(url.searchParams);

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			token: null,
			backQuery
		};
	}

	try {
		const response = await getTokenDetail(
			fetch,
			params.chain_ref,
			params.collection_ref,
			params.token_ref
		);
		return {
			chain: response.chain,
			collection: response.collection,
			token: response.token,
			backQuery
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeReturnQuery(searchParams: URLSearchParams): string | null {
	const rawQuery = searchParams.get('returnQuery');
	if (rawQuery && rawQuery.trim()) {
		return rawQuery.trim();
	}

	const rawCursor = searchParams.get('returnCursor');
	if (!rawCursor || !rawCursor.trim()) {
		return null;
	}

	const query = new URLSearchParams();
	query.set('cursor', rawCursor.trim());
	return query.toString();
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
