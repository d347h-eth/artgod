import type {
	BootstrapRunDetailApiResponse,
	BootstrapRetryFailedResponse,
	BootstrapRunCreateResponse,
	BootstrapRunsApiResponse,
	BootstrapStatusApiResponse,
	CollectionActivitiesApiResponse,
	CollectionCustomizationApiResponse,
	CollectionDetailApiResponse,
	CollectionHoldersApiResponse,
	CollectionsApiResponse,
	DefaultChainResponse,
	TokenDetailApiResponse
} from '$lib/api-types';
import { resolveBackendOrigin } from '$lib/runtime/backend-origin';

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
	for (;;) {
		try {
			return await requestJsonOnce<T>(fetchFn, `${backendOrigin}${path}`);
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
	const response = await fetchFn(url, {
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
	const response = await fetchFn(`${backendOrigin}/api/security/csrf`, {
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
