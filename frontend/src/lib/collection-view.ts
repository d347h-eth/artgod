import {
	TRAIT_CATALOG,
	TRAIT_CATALOG_QUERY,
	type CollectionViewStatus,
	type CollectionViewsResponse
} from '@artgod/shared/types/trait-catalog';
import { TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import type { ApiCollection } from '$lib/api-types';
import { joinPath, withQuery } from '$lib/route-paths';

const PICKER_ROUTE = 'views';
export const COLLECTION_VIEW_PICKER_QUERY = { Section: 'section', Group: 'group' } as const;

export function isCollectionViewPickerRoute(id: string): boolean {
	return id.endsWith(`/${PICKER_ROUTE}`);
}

export function isPublicCollectionViewRoute(id: string): boolean {
	return !id.startsWith('/[chain_ref]') && !id.startsWith('/e2e-harness') && id !== '/blockspace';
}

export type CollectionViewPage = {
	chainRef: string;
	collectionRef: string;
	basePath: string;
	discovery: CollectionViewsResponse & { collection: ApiCollection };
};
export type CollectionGroupScope = { groupId: string };
export type CatalogScope = Pick<CollectionViewStatus, 'id' | 'generation'> | CollectionGroupScope;

export function selectedCollectionView(
	context?: CollectionViewPage | null
): CollectionViewStatus | null {
	return (
		context?.discovery.views.find((item) => item.id === context.discovery.selectedViewId) ?? null
	);
}

/** The unqualified collection is All. A group spans each of its child views. */
export function selectedCollectionScope(
	context?: CollectionViewPage | null
): CollectionViewStatus | CollectionGroupScope | null {
	const leaf = selectedCollectionView(context);
	if (leaf) return leaf;
	const groupId = context?.discovery.selectedGroupId;
	return groupId ? { groupId } : null;
}

export function appendCatalogScope(
	query: URLSearchParams,
	scope?: CatalogScope | null
): URLSearchParams {
	for (const key of Object.values(TRAIT_CATALOG_QUERY)) query.delete(key);
	if (scope && 'groupId' in scope) {
		query.set(TRAIT_CATALOG_QUERY.Group, scope.groupId);
	} else if (scope) {
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

// Preserve section controls while clearing selections and continuations tied to the old scope.
export function selectCollectionViewHref(
	path: string,
	query: URLSearchParams,
	scope: CatalogScope | null
): string {
	const next = appendCatalogScope(new URLSearchParams(query), scope);
	for (const key of [
		...Object.values(TRAIT_FILTER_QUERY_PARAMS),
		PAGINATION_QUERY_PARAMS.Cursor,
		'returnPath',
		'returnQuery',
		'returnCursor'
	])
		next.delete(key);
	return withQuery(path, next);
}

// Bookmarked picker URLs can outlive a route. Only resume a section of this collection.
export async function resolveCollectionViewPickerDestination(
	basePath: string,
	url: URL,
	match: typeof import('$app/paths').match
) {
	const fallback = { path: basePath, query: '' };
	const section = url.searchParams.get(COLLECTION_VIEW_PICKER_QUERY.Section);
	if (!section?.startsWith('/') || section.startsWith('//') || section.includes('\\'))
		return fallback;
	if (!URL.canParse(section, url)) return fallback;
	const target = new URL(section, url);
	if (target.protocol !== url.protocol || target.host !== url.host) return fallback;
	const inCollection =
		target.pathname === basePath || target.pathname.startsWith(joinPath(basePath, ''));
	if (!inCollection) return fallback;

	const route = await match(target);
	if (!route || isCollectionViewPickerRoute(route.id) || 'token_ref' in route.params)
		return fallback;
	if (basePath === '/' && !isPublicCollectionViewRoute(route.id)) return fallback;
	return { path: target.pathname, query: target.searchParams.toString() };
}
