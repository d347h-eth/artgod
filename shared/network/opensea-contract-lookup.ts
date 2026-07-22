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

// Collection slug input accepted by OpenSea collection lookup clients.
export type OpenSeaCollectionSlugLookupInput = {
    slug: string;
};

// Contract token input accepted by OpenSea NFT collection lookups.
export type OpenSeaContractTokenLookupInput = {
    address: string;
    tokenId: string;
};

// Collection identity returned by OpenSea collection lookup endpoints.
export type OpenSeaResolvedContractCollection = {
    slug: string;
    contractAddresses: readonly string[];
};

// Collection identity returned for one NFT on a contract.
export type OpenSeaResolvedTokenCollection = {
    slug: string;
};

// Shared collection lookup port used by local OpenSea integrations.
export type OpenSeaContractLookupPort = {
    resolveCollectionByContract(
        input: OpenSeaContractLookupInput,
    ): Promise<OpenSeaResolvedContractCollection | null>;
    resolveCollectionBySlug(
        input: OpenSeaCollectionSlugLookupInput,
    ): Promise<OpenSeaResolvedContractCollection | null>;
    resolveCollectionByToken(
        input: OpenSeaContractTokenLookupInput,
    ): Promise<OpenSeaResolvedTokenCollection | null>;
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
    address?: unknown;
    collection?: unknown;
};

type OpenSeaCollectionResponse = {
    collection?: unknown;
    contracts?: unknown;
    slug?: unknown;
    collection_slug?: unknown;
};

type OpenSeaNftResponse = {
    nft?: unknown;
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
    FetchCollection: "fetch_collection",
    FetchContract: "fetch_contract",
    FetchNft: "fetch_nft",
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
            options.rateLimiter ??
            new OpenSeaApiRateLimiter(config.rateLimiter);
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
        return slug
            ? {
                  slug,
                  contractAddresses: normalizeOpenSeaContractAddresses(
                      response?.address,
                  ),
              }
            : null;
    }

    async resolveCollectionBySlug(
        input: OpenSeaCollectionSlugLookupInput,
    ): Promise<OpenSeaResolvedContractCollection | null> {
        const requestedSlug = normalizeOpenSeaSlug(input.slug);
        if (!requestedSlug) return null;
        await this.rateLimiter.wait(1, 0);
        const response = await retryOpenSeaApiCall({
            component: OPENSEA_CONTRACT_LOOKUP_LOG_COMPONENT,
            action: OPENSEA_CONTRACT_LOOKUP_ACTION.FetchCollection,
            retryPolicy: this.config.retryPolicy,
            shouldRetry: shouldRetryOpenSeaContractLookupError,
            call: () => this.fetchCollection(requestedSlug),
        });
        const slug = normalizeOpenSeaSlug(
            response?.collection ?? response?.slug ?? response?.collection_slug,
        );
        return slug
            ? {
                  slug,
                  contractAddresses: normalizeOpenSeaCollectionContracts(
                      response?.contracts,
                  ),
              }
            : null;
    }

    async resolveCollectionByToken(
        input: OpenSeaContractTokenLookupInput,
    ): Promise<OpenSeaResolvedTokenCollection | null> {
        await this.rateLimiter.wait(1, 0);
        const response = await retryOpenSeaApiCall({
            component: OPENSEA_CONTRACT_LOOKUP_LOG_COMPONENT,
            action: OPENSEA_CONTRACT_LOOKUP_ACTION.FetchNft,
            retryPolicy: this.config.retryPolicy,
            shouldRetry: shouldRetryOpenSeaContractLookupError,
            call: () => this.fetchNft(input.address, input.tokenId),
        });
        const slug = normalizeOpenSeaSlug(
            readRecordValue(response?.nft, "collection"),
        );
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

    private async fetchCollection(
        slug: string,
    ): Promise<OpenSeaCollectionResponse | null> {
        const response = await this.fetchImpl(buildCollectionUrl(slug), {
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
        return (await response.json()) as OpenSeaCollectionResponse;
    }

    private async fetchNft(
        address: string,
        tokenId: string,
    ): Promise<OpenSeaNftResponse | null> {
        const response = await this.fetchImpl(buildNftUrl(address, tokenId), {
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
        return (await response.json()) as OpenSeaNftResponse;
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

function buildCollectionUrl(slug: string): string {
    const url = new URL(
        `${OPENSEA_API_V2_PREFIX}/collections/${encodeURIComponent(slug)}`,
        OPENSEA_API_ORIGIN,
    );
    return url.toString();
}

function buildNftUrl(address: string, tokenId: string): string {
    const url = new URL(
        `${OPENSEA_API_V2_PREFIX}/chain/${OPENSEA_ETHEREUM_CHAIN_SLUG}/contract/${encodeURIComponent(
            address,
        )}/nfts/${encodeURIComponent(tokenId)}`,
        OPENSEA_API_ORIGIN,
    );
    return url.toString();
}

function normalizeOpenSeaSlug(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const slug = value.trim().toLowerCase();
    return slug.length > 0 ? slug : null;
}

function normalizeOpenSeaCollectionContracts(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((contract) => {
        if (!contract || typeof contract !== "object") return [];
        return normalizeOpenSeaContractAddresses(
            (contract as { address?: unknown }).address,
        );
    });
}

function normalizeOpenSeaContractAddresses(value: unknown): string[] {
    if (typeof value !== "string") return [];
    const address = value.trim().toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(address) ? [address] : [];
}

function readRecordValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
}
