import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	BackendApiError,
	getCollectionBiddingBidBook,
	getCollectionBiddingJobs
} from '$lib/backend-api';
import type { CollectionBiddingBidScopeFilter } from '$lib/bidding-query';
import { normalizeMediaMode } from '$lib/media-mode';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { parseSelectedTraitRanges, parseSelectedTraits } from '$lib/trait-filters';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			jobs: [],
			bidBook: {
				state: {
					source: 'orders',
					snapshotRefreshedAtMs: null,
					projectedAt: null,
					rowCount: 0,
					durationMs: null,
					lastError: null
				},
				bids: []
			},
			facets: [],
			basePath: '/',
			selectedTraits: parseSelectedTraits(url.searchParams),
			selectedTraitRanges: parseSelectedTraitRanges(url.searchParams),
			bidScope: parseBidScope(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get('media_mode'))
		};
	}

	try {
		// Load the authoritative jobs and source-selected bid book for this collection.
		const [response, bidBookResponse] = await Promise.all([
			getCollectionBiddingJobs(fetch, params.chain_ref, params.collection_ref),
			getCollectionBiddingBidBook(fetch, params.chain_ref, params.collection_ref, url.searchParams)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			jobs: response.jobs,
			bidBook: bidBookResponse.bidBook,
			facets: bidBookResponse.traits.facets,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
			selectedTraits: bidBookResponse.traits.selected,
			selectedTraitRanges: bidBookResponse.traits.selectedRanges,
			bidScope: bidBookResponse.scopeFilter,
			mediaMode: normalizeMediaMode(url.searchParams.get('media_mode'))
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function parseBidScope(searchParams: URLSearchParams): CollectionBiddingBidScopeFilter {
	return searchParams.get('bid_scope') === 'traits' ? 'traits' : 'collection';
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
