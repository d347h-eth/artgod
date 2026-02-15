import type {
	CollectionDetailApiResponse,
	CollectionsApiResponse,
	DefaultChainResponse
} from '$lib/api-types';

export class BackendApiError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
        this.name = "BackendApiError";
    }
}

export async function getDefaultChain(
    fetchFn: typeof fetch,
): Promise<DefaultChainResponse> {
    return requestJson<DefaultChainResponse>(fetchFn, "/api/chains/default");
}

export async function getCollectionsPage(
    fetchFn: typeof fetch,
    chainRef: string,
    params: URLSearchParams,
): Promise<CollectionsApiResponse> {
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    return requestJson<CollectionsApiResponse>(
        fetchFn,
        `/api/${encodeURIComponent(chainRef)}/collections${suffix}`,
    );
}

export async function getCollectionDetail(
    fetchFn: typeof fetch,
    chainRef: string,
    collectionRef: string,
    params: URLSearchParams,
): Promise<CollectionDetailApiResponse> {
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    return requestJson<CollectionDetailApiResponse>(
        fetchFn,
        `/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}${suffix}`,
    );
}

async function requestJson<T>(
    fetchFn: typeof fetch,
    path: string,
): Promise<T> {
    const backendOrigin = getBackendOrigin();
    const response = await fetchFn(`${backendOrigin}${path}`);
    const payload = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;

    if (!response.ok) {
        throw new BackendApiError(
            payload?.message ?? `Backend request failed with ${response.status}`,
            response.status,
        );
    }

    return payload as T;
}

function getBackendOrigin(): string {
    return process.env.PUBLIC_BACKEND_ORIGIN?.trim() || "http://127.0.0.1:3000";
}
