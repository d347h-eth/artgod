import type { OpenSeaHttpConfig } from "../config/opensea-http.js";
import {
    OpenSeaApiRateLimiter,
    retryOpenSeaApiCall,
} from "./opensea-api-resilience.js";

// Runtime configuration required by the shared OpenSea contract lookup client.
export type OpenSeaContractLookupConfig = {
    apiKey: string;
} & OpenSeaHttpConfig;

// Contract address input accepted by OpenSea contract lookup clients.
export type OpenSeaContractLookupInput = {
    address: string;
};

// Collection identity returned by OpenSea contract lookup endpoints.
export type OpenSeaResolvedContractCollection = {
    slug: string;
};

// Shared contract lookup port used by local OpenSea integrations.
export type OpenSeaContractLookupPort = {
    resolveCollectionByContract(
        input: OpenSeaContractLookupInput,
    ): Promise<OpenSeaResolvedContractCollection | null>;
};

// Fetch implementation boundary used by OpenSea REST client tests.
export type OpenSeaFetch = typeof fetch;

// Minimal limiter contract shared with OpenSea adapters that already own a bucket.
export type OpenSeaContractLookupRateLimiter = Pick<
    OpenSeaApiRateLimiter,
    "wait"
>;

// Optional dependencies for tests and adapters that already own a limiter.
export type OpenSeaContractLookupClientOptions = {
    fetch?: OpenSeaFetch;
    rateLimiter?: OpenSeaContractLookupRateLimiter;
};

type OpenSeaContractResponse = {
    collection?: unknown;
};

// Public OpenSea REST API origin used by the official SDK.
const OPENSEA_API_ORIGIN = "https://api.opensea.io";

// API version path segment for OpenSea marketplace REST endpoints.
const OPENSEA_API_V2_PREFIX = "/api/v2";

// OpenSea chain slug for Ethereum mainnet contract lookups.
const OPENSEA_ETHEREUM_CHAIN_SLUG = "ethereum";

// Header name used by OpenSea for authenticated REST requests.
const OPENSEA_API_KEY_HEADER_NAME = "X-API-KEY";

// Logger component label emitted by shared OpenSea contract lookup calls.
const OPENSEA_CONTRACT_LOOKUP_LOG_COMPONENT = "OpenSeaContractLookupClient";

// Low-cardinality action labels for OpenSea contract lookup retries.
const OPENSEA_CONTRACT_LOOKUP_ACTION = {
    FetchContract: "fetch_contract",
} as const;

// HTTP statuses that should fail fast instead of retrying contract lookups.
const OPENSEA_CONTRACT_LOOKUP_NON_RETRYABLE_STATUS_CODES = new Set([
    400, 401, 403, 404,
]);

// Fetches collection identity from OpenSea by contract address.
export class OpenSeaContractLookupClient implements OpenSeaContractLookupPort {
    private readonly rateLimiter: OpenSeaContractLookupRateLimiter;
    private readonly fetchImpl: OpenSeaFetch;

    constructor(
        private readonly config: OpenSeaContractLookupConfig,
        options: OpenSeaContractLookupClientOptions = {},
    ) {
        this.rateLimiter =
            options.rateLimiter ?? new OpenSeaApiRateLimiter(config.rateLimiter);
        this.fetchImpl = options.fetch ?? fetch;
    }

    async resolveCollectionByContract(
        input: OpenSeaContractLookupInput,
    ): Promise<OpenSeaResolvedContractCollection | null> {
        await this.rateLimiter.wait(1, 0);
        const response = await retryOpenSeaApiCall({
            component: OPENSEA_CONTRACT_LOOKUP_LOG_COMPONENT,
            action: OPENSEA_CONTRACT_LOOKUP_ACTION.FetchContract,
            retryPolicy: this.config.retryPolicy,
            shouldRetry: shouldRetryOpenSeaContractLookupError,
            call: () => this.fetchContract(input.address),
        });
        const slug = normalizeOpenSeaSlug(response?.collection);
        return slug ? { slug } : null;
    }

    private async fetchContract(
        address: string,
    ): Promise<OpenSeaContractResponse | null> {
        const response = await this.fetchImpl(buildContractUrl(address), {
            headers: {
                [OPENSEA_API_KEY_HEADER_NAME]: this.config.apiKey,
            },
        });
        if (response.status === 404) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new OpenSeaContractLookupStatusError(response.status);
        }
        return (await response.json()) as OpenSeaContractResponse;
    }
}

class OpenSeaContractLookupStatusError extends Error {
    constructor(readonly status: number) {
        super(`OpenSea HTTP ${status}`);
        this.name = "OpenSeaContractLookupStatusError";
    }
}

function shouldRetryOpenSeaContractLookupError(error: unknown): boolean {
    if (!(error instanceof OpenSeaContractLookupStatusError)) return true;
    return !OPENSEA_CONTRACT_LOOKUP_NON_RETRYABLE_STATUS_CODES.has(
        error.status,
    );
}

function buildContractUrl(address: string): string {
    const url = new URL(
        `${OPENSEA_API_V2_PREFIX}/chain/${OPENSEA_ETHEREUM_CHAIN_SLUG}/contract/${encodeURIComponent(
            address,
        )}`,
        OPENSEA_API_ORIGIN,
    );
    return url.toString();
}

function normalizeOpenSeaSlug(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const slug = value.trim().toLowerCase();
    return slug.length > 0 ? slug : null;
}
