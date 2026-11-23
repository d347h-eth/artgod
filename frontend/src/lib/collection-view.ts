import {
	TRAIT_CATALOG,
	TRAIT_CATALOG_QUERY,
	type CollectionViewStatus,
	type CollectionViewsResponse
} from '@artgod/shared/types/trait-catalog';
import { TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import { withQuery } from '$lib/route-paths';

export type CollectionViewPage = {
	chainRef: string;
	collectionRef: string;
	basePath: string;
	discovery: CollectionViewsResponse;
};
export type CatalogScope = Pick<CollectionViewStatus, 'id' | 'generation'>;

export function selectedCollectionView(
	context?: CollectionViewPage | null
): CollectionViewStatus | null {
	return (
		context?.discovery.views.find((item) => item.id === context.discovery.selectedViewId) ?? null
	);
}

export function appendCatalogScope(
	query: URLSearchParams,
	scope?: CatalogScope | null
): URLSearchParams {
	if (scope) {
		query.set(TRAIT_CATALOG_QUERY.View, scope.id);
		query.set(TRAIT_CATALOG_QUERY.Catalog, TRAIT_CATALOG.Derived);
		query.set(TRAIT_CATALOG_QUERY.Generation, String(scope.generation));
	}
	return query;
}

export function copyCatalogScope(query: URLSearchParams, source: URLSearchParams): URLSearchParams {
	for (const key of Object.values(TRAIT_CATALOG_QUERY)) {
		const value = source.get(key);
		if (value !== null) query.set(key, value);
	}
	return query;
}

// Preserve section controls while clearing selections and continuations tied to the old view.
export function selectCollectionViewHref(
	path: string,
	query: URLSearchParams,
	scope: CatalogScope
): string {
	const next = new URLSearchParams(query);
	for (const key of [
		...Object.values(TRAIT_FILTER_QUERY_PARAMS),
		PAGINATION_QUERY_PARAMS.Cursor,
		'returnPath',
		'returnQuery',
		'returnCursor'
	])
		next.delete(key);
	return withQuery(path, appendCatalogScope(next, scope));
}
