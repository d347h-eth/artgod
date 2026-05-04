import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	BackendApiError,
	getCollectionBiddingBidBook,
	getCollectionBiddingJobs
} from '$lib/backend-api';
import { resolvePreferredCollectionBiddingNavigationHref } from '$lib/bidding-navigation-preferences';
import {
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingView,
	parseCollectionBiddingTraitFilterJoinMode,
	parseShowMutedBidBook
} from '$lib/bidding-query';
import { normalizeMediaMode } from '$lib/media-mode';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionBiddingPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { parseSelectedTraitRanges, parseSelectedTraits } from '$lib/trait-filters';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionBiddingPath(), url.searchParams));
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			jobs: [],
			bidBook: {
				state: {
					source: 'orders',
					updatedAt: null,
					snapshotRefreshedAtMs: null,
					projectedAt: null,
					rowCount: 0,
					durationMs: null,
					lastError: null
				},
				bids: []
			},
			facets: [],
			media: {
				selectedMode: 'snapshot',
				defaultMode: 'snapshot',
				availableModes: [{ key: 'snapshot', label: 'snapshot' }]
			},
			included: {
				tokensById: {},
				hasTraitSummaryTemplate: false
			},
			basePath: '/',
			selectedTraits: parseSelectedTraits(url.searchParams),
			selectedTraitRanges: parseSelectedTraitRanges(url.searchParams),
			bidScope: parseCollectionBiddingBidScopeFilter(url.searchParams),
			traitJoinMode: parseCollectionBiddingTraitFilterJoinMode(url.searchParams),
			biddingView: parseCollectionBiddingView(url.searchParams),
			showMuted: parseShowMutedBidBook(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get('media_mode'))
		};
	}

	const preferredHref = resolvePreferredCollectionBiddingNavigationHref(url);
	if (preferredHref) {
		throw redirect(307, preferredHref);
	}

	try {
		// Load the authoritative jobs and source-selected bid book for this collection.
		const [response, bidBookResponse] = await Promise.all([
			getCollectionBiddingJobs(fetch, params.chain_ref, params.collection_ref, url.searchParams),
			getCollectionBiddingBidBook(fetch, params.chain_ref, params.collection_ref, url.searchParams)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			jobs: response.jobs,
			bidBook: bidBookResponse.bidBook,
			facets: bidBookResponse.traits.facets,
			media: response.media,
			included: response.included,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
			selectedTraits: bidBookResponse.traits.selected,
			selectedTraitRanges: bidBookResponse.traits.selectedRanges,
			bidScope: bidBookResponse.scopeFilter,
			traitJoinMode: parseCollectionBiddingTraitFilterJoinMode(url.searchParams),
			biddingView: parseCollectionBiddingView(url.searchParams),
			showMuted: parseShowMutedBidBook(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get('media_mode'))
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
