import type {
	BootstrapRunDetailApiResponse,
	BootstrapRetryFailedResponse,
	BootstrapContractProbeApiResponse,
	BootstrapImageCacheEstimateApiResponse,
	BootstrapOpenSeaSlugProbeApiResponse,
	BootstrapRunCreateResponse,
	BootstrapRunsApiResponse,
	BootstrapStepActionApiResponse,
	BatchTokenBiddingJobLookupApiResponse,
	BatchTokenBiddingJobMutationApiResponse,
	BiddingPriceTierReapplyApplyApiResponse,
	BiddingPriceTierReapplyPreviewApiResponse,
	BiddingJobMutationApiResponse,
	BiddingJobTargetLookupApiResponse,
	CollectionBiddingBidBookApiResponse,
	CollectionBiddingSettingsMutationApiResponse,
	CollectionBiddingJobMutationApiResponse,
	CollectionBiddingPriceTierMutationApiResponse,
	CollectionBiddingPriceTiersApiResponse,
	BootstrapStatusApiResponse,
	CollectionActivitiesApiResponse,
	CollectionCustomizationApiResponse,
	CollectionDetailApiResponse,
	CollectionHoldersApiResponse,
	CollectionPurgeApiResponse,
	CollectionTraitCatalogApiResponse,
	CollectionsApiResponse,
	DefaultChainResponse,
	ApiCollectionCustomizationSource,
	ApiImageCacheMode,
	OwnerRefResolutionApiResponse,
	RuntimeConfigApiResponse,
	ScheduleBlockspaceBackfillApiResponse,
	BlockspaceRangeSummaryApiResponse,
	BlockspaceStateApiResponse,
	TokenBiddingBidBookApiResponse,
	TokenBiddingJobApiResponse,
	TokenBiddingJobMutationApiResponse,
	TokenDetailApiResponse,
	TokenPreviewApiResponse,
	TraitBiddingJobMutationApiResponse
} from '$lib/api-types';
import { resolveBackendOrigin } from '$lib/runtime/backend-origin';
import { extractQueryCacheResponseHeaders } from '$lib/query-cache-response-headers';
import { browser } from '$app/environment';
import {
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	type CollectionBiddingTraitFilterJoinMode,
	type TokenBrowserStatus,
	type TradingBiddingTierSelectionMode
} from '@artgod/shared/types';
import type { BootstrapStepAction, BootstrapStepKey } from '@artgod/shared/bootstrap/pipeline';
import { API_CSRF_HEADER_NAME, API_CSRF_ROUTE_PATH } from '@artgod/shared/http/api-security';
import {
	buildCreateBootstrapRunPath,
	buildEstimateBootstrapImageCachePath,
	buildProbeBootstrapCollectionPath,
	buildProbeBootstrapOpenSeaSlugPath
} from '@artgod/shared/http/bootstrap-routes';
import { buildLookupBatchTokenBiddingJobsPath } from '@artgod/shared/http/trading-routes';
import {
	ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME,
	QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
	sanitizeHttpRequestTarget
} from '@artgod/shared/observability/http';
import { logger } from '@artgod/shared/utils/logger';

// Max duration for transient backend retry loop during early runtime startup.
const STARTUP_RETRY_WINDOW_MS = 12_000;
// Delay between startup retry attempts for transient backend failures.
const STARTUP_RETRY_DELAY_MS = 250;
const FRONTEND_SSR_LOG_COMPONENT = 'FrontendSSR';
const FRONTEND_SSR_BACKEND_API_RESPONSE_ACTION = 'backend_api_response';
const FRONTEND_SSR_BACKEND_API_FAILURE_ACTION = 'backend_api_failure';
const CSRF_REJECTION_MESSAGES = new Set(['Invalid CSRF token', 'Missing CSRF header']);
let csrfTokenCache: string | null = null;
let csrfTokenInflight: Promise<void> | null = null;

export type BackendJsonResponse<T> = {
	payload: T;
	headers: Headers;
};

export class BackendApiError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
		this.name = 'BackendApiError';
	}
}

export async function getDefaultChain(fetchFn: typeof fetch): Promise<DefaultChainResponse> {
	return requestJson<DefaultChainResponse>(fetchFn, '/api/chains/default');
}

export async function getRuntimeConfig(fetchFn: typeof fetch): Promise<RuntimeConfigApiResponse> {
	return requestJson<RuntimeConfigApiResponse>(fetchFn, '/api/runtime/config');
}

export async function getCollectionsPage(
	fetchFn: typeof fetch,
	chainRef: string,
	params: URLSearchParams
): Promise<CollectionsApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionsApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/collections${suffix}`
	);
}

export async function getBlockspaceState(
	fetchFn: typeof fetch,
	chainRef: string,
	params: URLSearchParams
): Promise<BlockspaceStateApiResponse> {
	return (await getBlockspaceStateWithHeaders(fetchFn, chainRef, params)).payload;
}

export async function getBlockspaceStateWithHeaders(
	fetchFn: typeof fetch,
	chainRef: string,
	params: URLSearchParams
): Promise<BackendJsonResponse<BlockspaceStateApiResponse>> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJsonResponse<BlockspaceStateApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/blockspace${suffix}`
	);
}

export async function getBlockspaceRangeSummary(
	fetchFn: typeof fetch,
	chainRef: string,
	params: URLSearchParams
): Promise<BlockspaceRangeSummaryApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<BlockspaceRangeSummaryApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/blockspace/range${suffix}`
	);
}

export async function scheduleBlockspaceBackfill(
	fetchFn: typeof fetch,
	chainRef: string,
	body: {
		collectionRef?: string | null;
		fromBlock: number;
		toBlock: number;
	}
): Promise<ScheduleBlockspaceBackfillApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<ScheduleBlockspaceBackfillApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/blockspace/backfill`,
		'POST',
		body
	);
}

export async function probeBootstrapCollectionContract(
	fetchFn: typeof fetch,
	chainRef: string,
	address: string,
	options: {
		imageSourceField?: string | null;
	} = {}
): Promise<BootstrapContractProbeApiResponse> {
	return requestJson<BootstrapContractProbeApiResponse>(
		fetchFn,
		buildProbeBootstrapCollectionPath({
			chainRef,
			address,
			standard: 'erc721',
			imageSourceField: options.imageSourceField
		})
	);
}

export async function getCollectionDetail(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<CollectionDetailApiResponse> {
	return (await getCollectionDetailWithHeaders(fetchFn, chainRef, collectionRef, params)).payload;
}

export async function getCollectionDetailWithHeaders(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<BackendJsonResponse<CollectionDetailApiResponse>> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJsonResponse<CollectionDetailApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}${suffix}`
	);
}

export async function getCollectionTraitCatalog(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<CollectionTraitCatalogApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionTraitCatalogApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/traits/catalog${suffix}`
	);
}

export async function getCollectionHolders(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<CollectionHoldersApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionHoldersApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/holders${suffix}`
	);
}

export async function getCollectionActivities(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<CollectionActivitiesApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionActivitiesApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/activity${suffix}`
	);
}

export async function resolveOwnerRef(
	fetchFn: typeof fetch,
	chainRef: string,
	value: string
): Promise<OwnerRefResolutionApiResponse> {
	const query = new URLSearchParams();
	query.set('value', value);
	return requestJson<OwnerRefResolutionApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/resolve-owner-ref?${query.toString()}`
	);
}

export async function getCollectionCustomization(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string
): Promise<CollectionCustomizationApiResponse> {
	return requestJson<CollectionCustomizationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/customization`
	);
}

export async function purgeCollection(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	confirmation: string
): Promise<CollectionPurgeApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<CollectionPurgeApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}`,
		'DELETE',
		{ confirmation }
	);
}

export async function getCollectionBiddingBidBook(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<CollectionBiddingBidBookApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionBiddingBidBookApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/bids${suffix}`
	);
}

export async function getCollectionBiddingPriceTiers(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string
): Promise<CollectionBiddingPriceTiersApiResponse> {
	return requestJson<CollectionBiddingPriceTiersApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/price-tiers`
	);
}

export async function getTokenBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tokenRef: string
): Promise<TokenBiddingJobApiResponse> {
	return requestJson<TokenBiddingJobApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/${encodeURIComponent(tokenRef)}/bidding/job`
	);
}

export async function getTokenBiddingBidBook(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tokenRef: string
): Promise<TokenBiddingBidBookApiResponse> {
	return requestJson<TokenBiddingBidBookApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/${encodeURIComponent(tokenRef)}/bidding/bids`
	);
}

export async function upsertTokenBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tokenRef: string,
	body: {
		status: 'enabled' | 'paused';
		floorEth?: string;
		ceilingEth?: string;
		deltaEth: string;
		priceTierId?: string | null;
	}
): Promise<TokenBiddingJobMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<TokenBiddingJobMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/${encodeURIComponent(tokenRef)}/bidding/job`,
		'PUT',
		body
	);
}

export async function archiveTokenBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tokenRef: string
): Promise<TokenBiddingJobMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<TokenBiddingJobMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/${encodeURIComponent(tokenRef)}/bidding/job`,
		'DELETE',
		{}
	);
}

export async function lookupBiddingJobTarget(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		target:
			| {
					type: 'token';
					tokenId: string;
			  }
			| {
					type: 'collection';
					quantity?: number;
			  }
			| {
					type: 'trait';
					quantity?: number;
					targetTraits: { type: string; value: string }[];
			  };
	}
): Promise<BiddingJobTargetLookupApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BiddingJobTargetLookupApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/jobs/target-lookup`,
		'POST',
		body
	);
}

export async function archiveBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	jobId: string
): Promise<BiddingJobMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BiddingJobMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/jobs/${encodeURIComponent(jobId)}`,
		'DELETE',
		{}
	);
}

export async function upsertTraitBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		status: 'enabled' | 'paused';
		floorEth?: string;
		ceilingEth?: string;
		deltaEth: string;
		priceTierId?: string | null;
		quantity?: number;
		targetTraits: { type: string; value: string }[];
	}
): Promise<TraitBiddingJobMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<TraitBiddingJobMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/jobs/traits`,
		'PUT',
		body
	);
}

export type BatchTokenBiddingJobSelectionRequest =
	| {
			type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds;
			tokenIds: string[];
	  }
	| {
			type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter;
			tokenStatus: TokenBrowserStatus;
			traits: { key: string; value: string }[];
			traitRanges: { key: string; fromValue: string | null; toValue: string | null }[];
			ownerAddress?: string | null;
	  }
	| {
			type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter;
			traits: { key: string; value: string }[];
			traitRanges: { key: string; fromValue: string | null; toValue: string | null }[];
			traitJoinMode: CollectionBiddingTraitFilterJoinMode;
			makerAddress?: string | null;
	  };

export async function lookupBatchTokenBiddingJobs(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		selection: BatchTokenBiddingJobSelectionRequest;
	}
): Promise<BatchTokenBiddingJobLookupApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BatchTokenBiddingJobLookupApiResponse>(
		fetchFn,
		buildLookupBatchTokenBiddingJobsPath({ chainRef, collectionRef }),
		'POST',
		body
	);
}

export async function upsertBatchTokenBiddingJobs(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		status: 'enabled' | 'paused';
		floorEth?: string;
		ceilingEth?: string;
		deltaEth: string;
		priceTierId?: string | null;
		selection: BatchTokenBiddingJobSelectionRequest;
	}
): Promise<BatchTokenBiddingJobMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BatchTokenBiddingJobMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/jobs/tokens/batch`,
		'PUT',
		body
	);
}

export async function upsertCollectionBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		status: 'enabled' | 'paused';
		floorEth?: string;
		ceilingEth?: string;
		deltaEth: string;
		priceTierId?: string | null;
		quantity?: number;
	}
): Promise<CollectionBiddingJobMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<CollectionBiddingJobMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/jobs/collection`,
		'PUT',
		body
	);
}

export async function upsertCollectionBiddingPriceTier(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		tierId?: string;
		name: string;
		status: 'enabled' | 'paused';
		sortOrder: number;
		parentTierId: string | null;
		floorConfig:
			| { kind: 'fixed'; valueEth: string }
			| {
					kind: 'parent_delta';
					deltaKind: 'absolute' | 'percent';
					deltaEth?: string;
					percent?: string;
			  };
		ceilingConfig:
			| { kind: 'fixed'; valueEth: string }
			| {
					kind: 'floor_delta' | 'parent_delta';
					deltaKind: 'absolute' | 'percent';
					deltaEth?: string;
					percent?: string;
			  };
		deltaEth: string;
	}
): Promise<CollectionBiddingPriceTierMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<CollectionBiddingPriceTierMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/price-tiers`,
		'PUT',
		body
	);
}

export async function updateCollectionBiddingSettings(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		tierSelectionMode: TradingBiddingTierSelectionMode;
		defaultDeltaEth: string;
	}
): Promise<CollectionBiddingSettingsMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<CollectionBiddingSettingsMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/settings`,
		'PUT',
		body
	);
}

export async function archiveCollectionBiddingPriceTier(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tierId: string
): Promise<CollectionBiddingPriceTierMutationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<CollectionBiddingPriceTierMutationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/price-tiers/${encodeURIComponent(tierId)}`,
		'DELETE',
		{}
	);
}

export async function previewBiddingPriceTierReapply(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tierId: string
): Promise<BiddingPriceTierReapplyPreviewApiResponse> {
	return requestJson<BiddingPriceTierReapplyPreviewApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/price-tiers/${encodeURIComponent(tierId)}/reapply-preview`
	);
}

export async function applyBiddingPriceTierReapply(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tierId: string,
	body: {
		jobIds: string[];
	}
): Promise<BiddingPriceTierReapplyApplyApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BiddingPriceTierReapplyApplyApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/price-tiers/${encodeURIComponent(tierId)}/reapply`,
		'POST',
		body
	);
}

export async function updateCollectionCustomization(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		traitFilterPresentation: {
			selectedSource: 'user' | 'extension';
			userConfig: {
				rangeKeys: string[];
			};
		};
		tokenCardTraitSummaryTemplate: {
			selectedSource: 'user' | 'extension';
			userConfig: {
				template: string;
			};
		};
		activityRowTraitSummaryTemplate: {
			selectedSource: 'user' | 'extension';
			userConfig: {
				template: string;
			};
		};
		imageCachePolicy: {
			selectedSource: 'user' | 'extension';
			userConfig: {
				imageCacheMode: ApiImageCacheMode;
				maxDimension: number | null;
			};
		};
	}
): Promise<CollectionCustomizationApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<CollectionCustomizationApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/customization`,
		'PUT',
		body
	);
}

export async function getTokenDetail(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tokenRef: string,
	params?: URLSearchParams
): Promise<TokenDetailApiResponse> {
	const query = params?.toString() ?? '';
	const suffix = query ? `?${query}` : '';
	return requestJson<TokenDetailApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/${encodeURIComponent(tokenRef)}${suffix}`
	);
}

export async function getTokenPreview(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	tokenRef: string,
	params?: URLSearchParams
): Promise<TokenPreviewApiResponse> {
	const query = params?.toString() ?? '';
	const suffix = query ? `?${query}` : '';
	return requestJson<TokenPreviewApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/${encodeURIComponent(tokenRef)}/preview${suffix}`
	);
}

export async function getActivityEventPreview(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	activityId: number,
	params?: URLSearchParams
): Promise<TokenPreviewApiResponse> {
	const query = params?.toString() ?? '';
	const suffix = query ? `?${query}` : '';
	return requestJson<TokenPreviewApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/activity/${encodeURIComponent(
			String(activityId)
		)}/preview${suffix}`
	);
}

export async function getBootstrapStatus(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string
): Promise<BootstrapStatusApiResponse> {
	return requestJson<BootstrapStatusApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bootstrap`
	);
}

export async function listBootstrapRuns(
	fetchFn: typeof fetch,
	chainRef: string,
	params: URLSearchParams
): Promise<BootstrapRunsApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<BootstrapRunsApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/bootstrap-runs${suffix}`
	);
}

export async function getBootstrapRunDetail(
	fetchFn: typeof fetch,
	chainRef: string,
	runId: number
): Promise<BootstrapRunDetailApiResponse> {
	return requestJson<BootstrapRunDetailApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/bootstrap-runs/${encodeURIComponent(String(runId))}`
	);
}

export async function createBootstrapRun(
	fetchFn: typeof fetch,
	chainRef: string,
	body: {
		slug: string;
		address: string;
		openseaSlug?: string;
		imageSourceField: string;
		standard: 'erc721';
		metadataMode: 'strict' | 'best_effort';
		supportsEnumerable: boolean;
		manualInput?:
			| {
					mode: 'manual_token_ids';
					tokenIds: string[];
			  }
			| {
					mode: 'manual_range';
					startTokenId: string;
					totalSupply: number;
			  };
		imageCache?: {
			selectedSource: ApiCollectionCustomizationSource;
			imageCacheMode: ApiImageCacheMode;
			maxDimension: number | null;
		};
		deploymentBlock?: number;
	}
): Promise<BootstrapRunCreateResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BootstrapRunCreateResponse>(
		fetchFn,
		buildCreateBootstrapRunPath(chainRef),
		'POST',
		body
	);
}

export async function probeBootstrapOpenSeaSlug(
	fetchFn: typeof fetch,
	chainRef: string,
	input:
		| {
				address: string;
				slug?: never;
		  }
		| {
				address?: never;
				slug: string;
		  }
): Promise<BootstrapOpenSeaSlugProbeApiResponse> {
	return requestJson<BootstrapOpenSeaSlugProbeApiResponse>(
		fetchFn,
		buildProbeBootstrapOpenSeaSlugPath({
			chainRef,
			...input
		})
	);
}

export async function estimateBootstrapImageCache(
	fetchFn: typeof fetch,
	chainRef: string,
	body: {
		sampleTokenId: string;
		sourceImageUrl: string;
		sourceImageBytes: number | null;
		totalSupply: string;
		imageCacheMode: ApiImageCacheMode;
		maxDimension: number | null;
	}
): Promise<BootstrapImageCacheEstimateApiResponse> {
	return requestJsonWithBody<BootstrapImageCacheEstimateApiResponse>(
		fetchFn,
		buildEstimateBootstrapImageCachePath(chainRef),
		'POST',
		body
	);
}

export async function retryBootstrapFailedTasks(
	fetchFn: typeof fetch,
	chainRef: string,
	runId: number
): Promise<BootstrapRetryFailedResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BootstrapRetryFailedResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/bootstrap-runs/${encodeURIComponent(String(runId))}/retry-failed`,
		'POST',
		{}
	);
}

export async function applyBootstrapStepAction(
	fetchFn: typeof fetch,
	chainRef: string,
	runId: number,
	stepKey: BootstrapStepKey,
	action: BootstrapStepAction
): Promise<BootstrapStepActionApiResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BootstrapStepActionApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/bootstrap-runs/${encodeURIComponent(
			String(runId)
		)}/steps/${encodeURIComponent(stepKey)}/${encodeURIComponent(action)}`,
		'POST',
		{}
	);
}

async function requestJson<T>(fetchFn: typeof fetch, path: string): Promise<T> {
	return (await requestJsonResponse<T>(fetchFn, path)).payload;
}

async function requestJsonResponse<T>(
	fetchFn: typeof fetch,
	path: string
): Promise<BackendJsonResponse<T>> {
	let backendOrigin: string;
	try {
		backendOrigin = await resolveBackendOrigin();
	} catch (cause) {
		throw new BackendApiError(toErrorMessage(cause), 503);
	}

	const deadline = Date.now() + STARTUP_RETRY_WINDOW_MS;
	const requestFetch = selectRequestFetch(fetchFn, backendOrigin);
	for (;;) {
		try {
			return await requestJsonOnce<T>(requestFetch, `${backendOrigin}${path}`);
		} catch (cause) {
			const mapped = toBackendApiError(cause);
			if (!isRetryableStartupError(mapped) || Date.now() >= deadline) {
				throw mapped;
			}
			await sleep(STARTUP_RETRY_DELAY_MS);
		}
	}
}

async function requestJsonOnce<T>(
	fetchFn: typeof fetch,
	url: string
): Promise<BackendJsonResponse<T>> {
	const requestLog = createSsrBackendRequestLogContext('GET', url);
	let response: Response;
	try {
		response = await fetchFn(url, buildBackendRequestInit({ credentials: 'include' }, requestLog));
	} catch (cause) {
		logSsrBackendApiFailure(requestLog, cause);
		throw cause;
	}
	const payload = (await response.json().catch(() => null)) as { message?: string } | null;
	logSsrBackendApiResponse(requestLog, response);

	if (!response.ok) {
		throw new BackendApiError(
			payload?.message ?? `Backend request failed with ${response.status}`,
			response.status
		);
	}

	return {
		payload: payload as T,
		headers: response.headers
	};
}

async function requestJsonWithBody<T>(
	fetchFn: typeof fetch,
	path: string,
	method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	body: unknown
): Promise<T> {
	await ensureCsrfToken(fetchFn);
	const backendOrigin = await resolveBackendOrigin();
	const url = `${backendOrigin}${path}`;
	const requestFetch = selectRequestFetch(fetchFn, backendOrigin);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const requestLog = createSsrBackendRequestLogContext(method, url);
		let response: Response;
		try {
			response = await requestFetch(
				url,
				buildBackendRequestInit(
					{
						method,
						credentials: 'include',
						headers: {
							'content-type': 'application/json',
							[API_CSRF_HEADER_NAME]: csrfTokenCache ?? ''
						},
						body: JSON.stringify(body)
					},
					requestLog
				)
			);
		} catch (cause) {
			logSsrBackendApiFailure(requestLog, cause);
			throw cause;
		}
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		logSsrBackendApiResponse(requestLog, response);
		if (response.ok) {
			return payload as T;
		}
		if (attempt === 0 && isCsrfRejection(response.status, payload?.message)) {
			clearCsrfTokenCache();
			// Refresh once after the backend hook rejects a stale tab-local token.
			await ensureCsrfToken(fetchFn);
			continue;
		}
		throw new BackendApiError(
			payload?.message ?? `Backend request failed with ${response.status}`,
			response.status
		);
	}
	throw new BackendApiError('Backend request failed', 500);
}

async function ensureCsrfToken(fetchFn: typeof fetch): Promise<void> {
	if (csrfTokenCache) return;
	if (csrfTokenInflight) {
		await csrfTokenInflight;
		return;
	}
	csrfTokenInflight = fetchCsrfToken(fetchFn).finally(() => {
		csrfTokenInflight = null;
	});
	await csrfTokenInflight;
}

async function fetchCsrfToken(fetchFn: typeof fetch): Promise<void> {
	const backendOrigin = await resolveBackendOrigin();
	const requestFetch = selectRequestFetch(fetchFn, backendOrigin);
	const url = `${backendOrigin}${API_CSRF_ROUTE_PATH}`;
	const requestLog = createSsrBackendRequestLogContext('GET', url);
	let response: Response;
	try {
		response = await requestFetch(
			url,
			buildBackendRequestInit(
				{
					method: 'GET',
					credentials: 'include'
				},
				requestLog
			)
		);
	} catch (cause) {
		logSsrBackendApiFailure(requestLog, cause);
		throw cause;
	}
	const payload = (await response.json().catch(() => null)) as { token?: string } | null;
	logSsrBackendApiResponse(requestLog, response);
	if (!response.ok || !payload?.token) {
		throw new BackendApiError('Unable to initialize CSRF token', response.status);
	}
	csrfTokenCache = payload.token;
}

function clearCsrfTokenCache(): void {
	csrfTokenCache = null;
	csrfTokenInflight = null;
}

function isCsrfRejection(status: number, message: string | undefined): boolean {
	return status === 403 && typeof message === 'string' && CSRF_REJECTION_MESSAGES.has(message);
}

function isRetryableStartupError(error: BackendApiError): boolean {
	return (
		error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504
	);
}

function toBackendApiError(cause: unknown): BackendApiError {
	if (cause instanceof BackendApiError) {
		return cause;
	}
	return new BackendApiError(toErrorMessage(cause), 503);
}

function toErrorMessage(value: unknown): string {
	if (value instanceof Error && value.message.trim()) {
		return value.message;
	}
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	return 'Backend origin resolution failed';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectRequestFetch(fetchFn: typeof fetch, backendOrigin: string): typeof fetch {
	if (!browser && backendOrigin) {
		return globalThis.fetch;
	}
	return fetchFn;
}

type SsrBackendRequestLogContext = {
	requestId: string;
	method: string;
	url: string;
	startedAtMs: number;
};

function createSsrBackendRequestLogContext(
	method: string,
	url: string
): SsrBackendRequestLogContext | null {
	if (browser) return null;
	return {
		requestId: createBackendRequestId(),
		method,
		url,
		startedAtMs: Date.now()
	};
}

function buildBackendRequestInit(
	init: RequestInit,
	requestLog: SsrBackendRequestLogContext | null
): RequestInit {
	if (!requestLog) return init;

	const headers = new Headers(init.headers);
	headers.set(ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME, requestLog.requestId);
	return {
		...init,
		headers
	};
}

function logSsrBackendApiResponse(
	requestLog: SsrBackendRequestLogContext | null,
	response: Response
): void {
	if (!requestLog) return;
	const cacheHeaders = extractQueryCacheResponseHeaders(response.headers);
	const target = sanitizeHttpRequestTarget(requestLog.url);
	logger.info('Frontend SSR backend API response', {
		component: FRONTEND_SSR_LOG_COMPONENT,
		action: FRONTEND_SSR_BACKEND_API_RESPONSE_ACTION,
		method: requestLog.method,
		path: target.path,
		queryKeys: target.queryKeys,
		queryParamCount: target.queryParamCount,
		redactedQueryParamCount: target.redactedQueryParamCount,
		statusCode: response.status,
		durationMs: Date.now() - requestLog.startedAtMs,
		ssrBackendRequestId: requestLog.requestId,
		queryCacheStatus: cacheHeaders[QUERY_CACHE_DEBUG_HEADER_NAME] ?? null,
		queryCacheAgeMs: parseOptionalInteger(cacheHeaders[QUERY_CACHE_DEBUG_AGE_HEADER_NAME]),
		queryCacheTtlMs: parseOptionalInteger(cacheHeaders[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]),
		responseHeaders: cacheHeaders
	});
}

function logSsrBackendApiFailure(
	requestLog: SsrBackendRequestLogContext | null,
	cause: unknown
): void {
	if (!requestLog) return;
	const target = sanitizeHttpRequestTarget(requestLog.url);
	logger.warn('Frontend SSR backend API request failed', {
		component: FRONTEND_SSR_LOG_COMPONENT,
		action: FRONTEND_SSR_BACKEND_API_FAILURE_ACTION,
		method: requestLog.method,
		path: target.path,
		queryKeys: target.queryKeys,
		queryParamCount: target.queryParamCount,
		redactedQueryParamCount: target.redactedQueryParamCount,
		durationMs: Date.now() - requestLog.startedAtMs,
		ssrBackendRequestId: requestLog.requestId,
		error: toErrorMessage(cause)
	});
}

function createBackendRequestId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function parseOptionalInteger(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}
