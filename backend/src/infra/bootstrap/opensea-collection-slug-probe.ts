import type { OpenSeaHttpConfig } from "@artgod/shared/config/opensea-http";
import {
    OpenSeaApiRateLimiter,
    retryOpenSeaApiCall,
} from "@artgod/shared/network/opensea-api-resilience";
import type { OpenSeaCollectionSlugProbePort } from "../../application/use-cases/bootstrap/probe-opensea-collection-slug.js";

type OpenSeaCollectionSlugProbeConfig = {
    apiKey: string;
} & OpenSeaHttpConfig;

type FetchLike = typeof fetch;

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

// Logger component label emitted by the backend OpenSea slug probe adapter.
const OPENSEA_SLUG_PROBE_LOG_COMPONENT = "OpenSeaCollectionSlugProbe";

// Low-cardinality action labels for backend OpenSea slug probe retries.
const OPENSEA_SLUG_PROBE_ACTION = {
    FetchContract: "fetch_contract",
} as const;

const OPENSEA_NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

export class OpenSeaCollectionSlugProbeAdapter implements OpenSeaCollectionSlugProbePort {
    private readonly rateLimiter: OpenSeaApiRateLimiter;

    constructor(
        private readonly config: OpenSeaCollectionSlugProbeConfig,
        private readonly fetchImpl: FetchLike = fetch,
    ) {
        this.rateLimiter = new OpenSeaApiRateLimiter(config.rateLimiter);
    }

    async resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null> {
        await this.rateLimiter.wait(1, 0);
        const response = await retryOpenSeaApiCall({
            component: OPENSEA_SLUG_PROBE_LOG_COMPONENT,
            action: OPENSEA_SLUG_PROBE_ACTION.FetchContract,
            retryPolicy: this.config.retryPolicy,
            shouldRetry: shouldRetryOpenSeaError,
            call: () => this.fetchContract(input.address),
        });
        return normalizeOpenSeaSlug(response?.collection);
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
            throw new OpenSeaHttpStatusError(response.status);
        }
        return (await response.json()) as OpenSeaContractResponse;
    }
}

class OpenSeaHttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`OpenSea HTTP ${status}`);
        this.name = "OpenSeaHttpStatusError";
    }
}

function shouldRetryOpenSeaError(error: unknown): boolean {
    if (!(error instanceof OpenSeaHttpStatusError)) return true;
    return !OPENSEA_NON_RETRYABLE_STATUS_CODES.has(error.status);
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
