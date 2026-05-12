import type {
	BootstrapRunDetailApiResponse,
	BootstrapRetryFailedResponse,
	BootstrapRunCreateResponse,
	BootstrapRunsApiResponse,
	CollectionBiddingBidBookApiResponse,
	BootstrapStatusApiResponse,
	CollectionBiddingJobsApiResponse,
	CollectionActivitiesApiResponse,
	CollectionCustomizationApiResponse,
	CollectionDetailApiResponse,
	CollectionHoldersApiResponse,
	CollectionsApiResponse,
	DefaultChainResponse,
	OwnerRefResolutionApiResponse,
	TokenBiddingBidBookApiResponse,
	TokenBiddingJobApiResponse,
	TokenBiddingJobMutationApiResponse,
	TokenDetailApiResponse,
	TokenPreviewApiResponse,
	TraitBiddingJobMutationApiResponse
} from '$lib/api-types';
import { resolveBackendOrigin } from '$lib/runtime/backend-origin';
import { browser } from '$app/environment';

// Max duration for transient backend retry loop during early runtime startup.
const STARTUP_RETRY_WINDOW_MS = 12_000;
// Delay between startup retry attempts for transient backend failures.
const STARTUP_RETRY_DELAY_MS = 250;
let csrfTokenCache: string | null = null;

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

export async function getCollectionDetail(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params: URLSearchParams
): Promise<CollectionDetailApiResponse> {
	const query = params.toString();
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionDetailApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}${suffix}`
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

export async function getCollectionBiddingJobs(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	params?: URLSearchParams
): Promise<CollectionBiddingJobsApiResponse> {
	const query = params?.toString() ?? '';
	const suffix = query ? `?${query}` : '';
	return requestJson<CollectionBiddingJobsApiResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/jobs${suffix}`
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
		floorEth: string;
		ceilingEth: string;
		deltaEth: string;
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

export async function upsertTraitBiddingJob(
	fetchFn: typeof fetch,
	chainRef: string,
	collectionRef: string,
	body: {
		status: 'enabled' | 'paused';
		floorEth: string;
		ceilingEth: string;
		deltaEth: string;
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
		deploymentBlock?: number;
	}
): Promise<BootstrapRunCreateResponse> {
	await ensureCsrfToken(fetchFn);
	return requestJsonWithBody<BootstrapRunCreateResponse>(
		fetchFn,
		`/api/${encodeURIComponent(chainRef)}/collections/bootstrap`,
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

async function requestJson<T>(fetchFn: typeof fetch, path: string): Promise<T> {
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

async function requestJsonOnce<T>(fetchFn: typeof fetch, url: string): Promise<T> {
	const response = await fetchFn(url, { credentials: 'include' });
	const payload = (await response.json().catch(() => null)) as { message?: string } | null;

	if (!response.ok) {
		throw new BackendApiError(
			payload?.message ?? `Backend request failed with ${response.status}`,
			response.status
		);
	}

	return payload as T;
}

async function requestJsonWithBody<T>(
	fetchFn: typeof fetch,
	path: string,
	method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	body: unknown
): Promise<T> {
	const backendOrigin = await resolveBackendOrigin();
	const url = `${backendOrigin}${path}`;
	const requestFetch = selectRequestFetch(fetchFn, backendOrigin);
	const response = await requestFetch(url, {
		method,
		credentials: 'include',
		headers: {
			'content-type': 'application/json',
			'x-artgod-csrf': csrfTokenCache ?? ''
		},
		body: JSON.stringify(body)
	});
	const payload = (await response.json().catch(() => null)) as { message?: string } | null;
	if (!response.ok) {
		throw new BackendApiError(
			payload?.message ?? `Backend request failed with ${response.status}`,
			response.status
		);
	}
	return payload as T;
}

async function ensureCsrfToken(fetchFn: typeof fetch): Promise<void> {
	if (csrfTokenCache) return;
	const backendOrigin = await resolveBackendOrigin();
	const requestFetch = selectRequestFetch(fetchFn, backendOrigin);
	const response = await requestFetch(`${backendOrigin}/api/security/csrf`, {
		method: 'GET',
		credentials: 'include'
	});
	const payload = (await response.json().catch(() => null)) as { token?: string } | null;
	if (!response.ok || !payload?.token) {
		throw new BackendApiError('Unable to initialize CSRF token', response.status);
	}
	csrfTokenCache = payload.token;
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
