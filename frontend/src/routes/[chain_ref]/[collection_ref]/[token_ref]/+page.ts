import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getTokenDetail } from '$lib/backend-api';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const backCursor = normalizeCursor(url.searchParams.get('returnCursor'));

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			token: null,
			backCursor
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
			backCursor
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeCursor(raw: string | null): string | null {
	if (!raw) return null;
	const value = raw.trim();
	return value.length > 0 ? value : null;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
