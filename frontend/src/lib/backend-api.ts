import type {
	CollectionDetailApiResponse,
	CollectionsApiResponse,
	DefaultChainResponse
} from '$lib/api-types';
import { resolveBackendOrigin } from '$lib/runtime/backend-origin';
import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';

// Max duration for transient backend retry loop during early runtime startup.
const STARTUP_RETRY_WINDOW_MS = 12_000;
// Delay between startup retry attempts for transient backend failures.
const STARTUP_RETRY_DELAY_MS = 250;
// Max time API requests wait for desktop runtime to report `running`.
const READY_WAIT_TIMEOUT_MS = 30_000;

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

async function requestJson<T>(fetchFn: typeof fetch, path: string): Promise<T> {
	const trackStartup = !desktopRuntimeStore.isLifecycleReady();
	if (trackStartup) {
		desktopRuntimeStore.reportLifecycleEvent(
			'info',
			'api.wait_runtime_ready.start',
			'Waiting for runtime readiness before backend request',
			{ path }
		);
	}

	await desktopRuntimeStore.waitUntilReady(READY_WAIT_TIMEOUT_MS);
	if (trackStartup) {
		desktopRuntimeStore.reportLifecycleEvent(
			'info',
			'api.wait_runtime_ready.done',
			'Runtime readiness wait finished',
			{ path }
		);
	}

	let backendOrigin: string;
	try {
		backendOrigin = await resolveBackendOrigin();
	} catch (cause) {
		if (trackStartup) {
			desktopRuntimeStore.reportLifecycleEvent(
				'error',
				'api.resolve_origin.failed',
				'Failed to resolve backend origin',
				{ path, reason: toErrorMessage(cause) }
			);
		}
		throw new BackendApiError(toErrorMessage(cause), 503);
	}

	const deadline = Date.now() + STARTUP_RETRY_WINDOW_MS;
	let attempt = 0;
	for (;;) {
		try {
			attempt += 1;
			if (trackStartup) {
				desktopRuntimeStore.reportLifecycleEvent(
					'info',
					'api.request.start',
					'Sending backend request',
					{ path, attempt }
				);
			}
			const payload = await requestJsonOnce<T>(fetchFn, `${backendOrigin}${path}`);
			desktopRuntimeStore.markApiReady();
			if (trackStartup) {
				desktopRuntimeStore.reportLifecycleEvent(
					'info',
					'api.request.success',
					'Backend request succeeded',
					{ path, attempt }
				);
			}
			return payload;
		} catch (cause) {
			const mapped = toBackendApiError(cause);
			if (!isRetryableStartupError(mapped) || Date.now() >= deadline) {
				if (trackStartup) {
					desktopRuntimeStore.reportLifecycleEvent(
						'error',
						'api.request.fail.final',
						'Backend request failed and will not be retried',
						{
							path,
							attempt,
							status: mapped.status,
							message: mapped.message
						}
					);
				}
				throw mapped;
			}
			if (trackStartup) {
				desktopRuntimeStore.reportLifecycleEvent(
					'warn',
					'api.retry',
					'Retrying backend request after transient startup failure',
					{
						path,
						attempt,
						status: mapped.status,
						retryDelayMs: STARTUP_RETRY_DELAY_MS
					}
				);
			}
			await sleep(STARTUP_RETRY_DELAY_MS);
		}
	}
}

async function requestJsonOnce<T>(fetchFn: typeof fetch, url: string): Promise<T> {
	const response = await fetchFn(url);
	const payload = (await response.json().catch(() => null)) as { message?: string } | null;

	if (!response.ok) {
		throw new BackendApiError(
			payload?.message ?? `Backend request failed with ${response.status}`,
			response.status
		);
	}

	return payload as T;
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
