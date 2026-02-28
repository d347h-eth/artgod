import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionDetail } from '$lib/backend-api';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const query = normalizeCollectionDetailParams(url.searchParams);
	const displayMode = parseDisplayMode(url.searchParams.get('mode'));

	try {
		const response = await getCollectionDetail(
			fetch,
			params.chain_ref,
			params.collection_ref,
			query
		);
		return {
			chain: response.chain,
			collection: response.collection,
			tokens: response.tokens,
			facets: response.traits.facets,
			selectedTraits: response.traits.selected,
			basePath: `/${response.chain.slug}/${response.collection.slug ?? response.collection.address}`,
			requestCursor: query.get('cursor') ?? null,
			displayMode
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeCollectionDetailParams(raw: URLSearchParams): URLSearchParams {
	const params = new URLSearchParams();

	const limit = raw.get('limit');
	params.set('limit', limit && /^\d+$/.test(limit) ? limit : String(DEFAULT_PAGE_LIMIT));

	const cursor = raw.get('cursor');
	if (cursor && cursor.trim()) {
		params.set('cursor', cursor.trim());
	}

	const traitValues = [...raw.getAll('traits'), ...raw.getAll('trait')];
	for (const value of traitValues) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			params.append('traits', trimmed);
		}
	}

	return params;
}

function parseDisplayMode(raw: string | null): 'grid' | 'table' {
	if (raw?.trim().toLowerCase() === 'table') return 'table';
	return 'grid';
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
