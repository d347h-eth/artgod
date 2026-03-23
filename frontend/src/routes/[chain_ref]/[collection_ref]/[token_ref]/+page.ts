import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getTokenDetail } from '$lib/backend-api';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const { backPath, backQuery } = normalizeReturnState(url.searchParams);
	const mediaMode = normalizeMediaMode(url.searchParams.get('media_mode'));

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			media: {
				selectedMode: 'snapshot',
				defaultMode: 'snapshot',
				availableModes: [{ key: 'snapshot', label: 'snapshot' }]
			},
			token: null,
			backPath,
			backQuery
		};
	}

	try {
		const response = await getTokenDetail(
			fetch,
			params.chain_ref,
			params.collection_ref,
			params.token_ref,
			buildMediaModeQuery(mediaMode)
		);
		return {
			chain: response.chain,
			collection: response.collection,
			media: response.media,
			token: response.token,
			backPath,
			backQuery
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeReturnState(searchParams: URLSearchParams): {
	backPath: string | null;
	backQuery: string | null;
} {
	const rawPath = searchParams.get('returnPath');
	const backPath = rawPath && rawPath.startsWith('/') ? rawPath : null;

	const rawQuery = searchParams.get('returnQuery');
	if (rawQuery && rawQuery.trim()) {
		return {
			backPath,
			backQuery: rawQuery.trim()
		};
	}

	const rawCursor = searchParams.get('returnCursor');
	if (!rawCursor || !rawCursor.trim()) {
		return {
			backPath,
			backQuery: null
		};
	}

	const query = new URLSearchParams();
	query.set('cursor', rawCursor.trim());
	return {
		backPath,
		backQuery: query.toString()
	};
}

function buildMediaModeQuery(mediaMode: string | null): URLSearchParams {
	const query = new URLSearchParams();
	appendMediaModeParam(query, mediaMode);
	return query;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
