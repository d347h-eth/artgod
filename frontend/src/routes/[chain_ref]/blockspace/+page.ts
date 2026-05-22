import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BLOCKSPACE_CONTEXT_ANY } from '@artgod/shared/config/blockspace';
import { BackendApiError, getBlockspaceState } from '$lib/backend-api';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import {
	buildBlockspaceStackStateApiParams,
	buildBlockspaceVisibleLevels,
	buildBlockspaceVisibleStackPagesFromEntries,
	formatBlockspacePageStackEntry,
	parseBlockspacePageStack,
	type BlockspacePageStackEntry
} from '$lib/blockspace-page-stack';

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

	const query = normalizeBlockspaceParams(url.searchParams);
	try {
		// Fetch each visible path page so the renderer can stack the current navigation branch.
		const states = await Promise.all(
			buildBlockspaceStackStateApiParams(
				query.collection,
				buildBlockspaceVisibleStackPagesFromEntries(query.stackPages)
			).map((apiParams) =>
				getBlockspaceState(fetch, params.chain_ref, apiParams)
			)
		);
		const state = states.at(-1) ?? null;
		if (!state) {
			throw error(500, 'Backend request failed');
		}
		return {
			state,
			levels: buildBlockspaceVisibleLevels(query.stack, states),
			basePath: `/${state.chain.slug}/blockspace`,
			collection: query.collection,
			stack: query.stack
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeBlockspaceParams(raw: URLSearchParams): {
	collection: string;
	stack: string[];
	stackPages: BlockspacePageStackEntry[];
} {
	const collection = raw.get('collection')?.trim() || BLOCKSPACE_CONTEXT_ANY;
	const stack = parseBlockspacePageStack(raw.get('stack'));
	if (!stack) {
		throw error(400, 'Invalid page stack');
	}

	return {
		collection,
		stack: stack.map(formatBlockspacePageStackEntry),
		stackPages: stack
	};
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
