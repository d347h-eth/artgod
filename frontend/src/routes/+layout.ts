import { PRICE_HISTORY_QUERY } from '@artgod/shared/http/collection-routes';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import { match } from '$app/paths';
import type { LayoutLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { TRAIT_CATALOG_QUERY } from '@artgod/shared/types/trait-catalog';
import { BackendApiError, getCollectionViews } from '$lib/backend-api';
import {
	appendCatalogScope,
	COLLECTION_VIEW_PICKER_QUERY,
	isCollectionViewPickerRoute,
	isPublicCollectionViewRoute,
	resolveCollectionViewPickerDestination,
	selectCollectionViewHref,
	selectedCollectionScope
} from '$lib/collection-view';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';
import { withQuery } from '$lib/route-paths';

// Keep web mode SSR-enabled by default; admin/userland desktop builds run as static SPAs.
const target = (import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() ?? 'web';
export const ssr = target === 'web';

export const load: LayoutLoad = async ({ route, params, url, fetch }) => {
	const id = route.id ?? '';
	const publicRoute = IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT && isPublicCollectionViewRoute(id);
	const pickerRoute = isCollectionViewPickerRoute(id);
	let scope = publicRoute ? PUBLIC_COLLECTION_SCOPE : null;
	if (
		!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT &&
		id.startsWith('/[chain_ref]/[collection_ref]') &&
		params.chain_ref &&
		params.collection_ref
	) {
		scope = { chainRef: params.chain_ref, collectionRef: params.collection_ref };
	}
	if (IS_ADMIN_FRONTEND_TARGET || !scope) {
		if (pickerRoute) throw error(404, 'This collection has no views.');
		return { collectionViewPage: null };
	}

	const query = new URLSearchParams();
	const view = url.searchParams.get(TRAIT_CATALOG_QUERY.View);
	const group = url.searchParams.get(TRAIT_CATALOG_QUERY.Group);
	// A bookmarked token can move to another view when its metadata changes.
	if (params.token_ref) query.set(PRICE_HISTORY_QUERY.TokenId, params.token_ref);
	else if (!pickerRoute) {
		if (view) query.set(TRAIT_CATALOG_QUERY.View, view);
		if (group) query.set(TRAIT_CATALOG_QUERY.Group, group);
	}
	const basePath = publicRoute
		? '/'
		: '/' + encodeURIComponent(scope.chainRef) + '/' + encodeURIComponent(scope.collectionRef);
	try {
		const discovery = await getCollectionViews(fetch, scope.chainRef, scope.collectionRef, query);
		if (!discovery.required) {
			if (pickerRoute) throw error(404, 'This collection has no views.');
			return { collectionViewPage: null };
		}
		const context = { ...scope, basePath, discovery };
		if (pickerRoute) {
			const destination = await resolveCollectionViewPickerDestination(basePath, url, match);
			const legacyGroup = url.searchParams.get(COLLECTION_VIEW_PICKER_QUERY.Group);
			const group = discovery.views.find((item) => item.parent?.id === legacyGroup)?.parent;
			throw redirect(
				307,
				selectCollectionViewHref(
					destination.path,
					new URLSearchParams(destination.query),
					group ? { groupId: group.id } : null
				)
			);
		}

		const selected = selectedCollectionScope(context);
		if (!selected && !params.token_ref && (view || group))
			throw error(404, 'This collection view is unavailable.');
		const normalized = appendCatalogScope(new URLSearchParams(), selected);
		if (
			Object.values(TRAIT_CATALOG_QUERY).some(
				(key) => url.searchParams.get(key) !== normalized.get(key)
			)
		) {
			const next = appendCatalogScope(new URLSearchParams(url.searchParams), selected);
			next.delete(PAGINATION_QUERY_PARAMS.Cursor);
			throw redirect(307, withQuery(url.pathname, next));
		}
		return { collectionViewPage: context };
	} catch (cause) {
		if (cause instanceof BackendApiError) throw error(cause.status, cause.message);
		throw cause;
	}
};
