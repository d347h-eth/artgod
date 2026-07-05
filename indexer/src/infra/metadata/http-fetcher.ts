import { logger } from "@artgod/shared/utils";
import type { Metrics } from "@artgod/shared/observability/metrics";
import type { MetadataFetcherPort } from "../../ports/metadata.js";
import type {
    MetadataAttribute,
    TokenMetadata,
} from "../../domain/metadata.js";
import {
    parseJsonDataUriText,
    resolveTokenResourceUri,
} from "@artgod/shared/media/token-resource-uri";
import { selectTokenMetadataImageSource } from "@artgod/shared/media/token-metadata-image-source";
import { getDefaultHttpFetchResilienceConfig } from "@artgod/shared/config/http-fetch-resilience";
import {
    fetchWithHttpResilience,
    type HttpFetchResilienceConfig,
} from "@artgod/shared/network/http-fetch-resilience";

export type HttpMetadataFetcherConfig = {
    timeoutMs?: number;
    ipfsGateway?: string;
    fetchResilience?: HttpFetchResilienceConfig;
    metrics?: Metrics;
};

export class HttpMetadataFetcher implements MetadataFetcherPort {
    private fetchResilience: HttpFetchResilienceConfig;
    private ipfsGatewayOrigin: string;
    private metrics?: Metrics;

    constructor(config: HttpMetadataFetcherConfig = {}) {
        const defaultFetchResilience = getDefaultHttpFetchResilienceConfig();
        this.fetchResilience = config.fetchResilience ?? {
            ...defaultFetchResilience,
            requestTimeoutMs:
                config.timeoutMs ?? defaultFetchResilience.requestTimeoutMs,
        };
        this.ipfsGatewayOrigin = config.ipfsGateway ?? "https://ipfs.io";
        this.metrics = config.metrics;
    }

    async fetchMetadata(
        uri: string,
        options?: {
            imageSourceField?: string | null;
        },
    ): Promise<TokenMetadata | null> {
        const resolved = resolveTokenResourceUri(uri, {
            ipfsGatewayOrigin: this.ipfsGatewayOrigin,
        });
        if (!resolved) {
            this.metrics?.increment("metadata.fetch.failure", 1, {
                reason: "unsupported_uri",
            });
            logger.debug("Metadata fetch skipped (unsupported URI)", {
                component: "MetadataFetcher",
                action: "fetchMetadata",
                uri,
            });
            return null;
        }

        const start = Date.now();
        try {
            const raw = resolved.startsWith("data:")
                ? parseDataUri(resolved)
                : await fetchJson(resolved, this.fetchResilience);
            const metadata = normalizeMetadata(uri, raw, {
                imageSourceField: options?.imageSourceField ?? null,
                ipfsGatewayOrigin: this.ipfsGatewayOrigin,
            });
            if (!metadata) {
                this.metrics?.increment("metadata.fetch.failure", 1, {
                    reason: "invalid_json",
                });
                return null;
            }
            this.metrics?.increment("metadata.fetch.success", 1);
            this.metrics?.histogram(
                "metadata.fetch.latency",
                Date.now() - start,
                { result: "ok" },
            );
            return metadata;
        } catch (error) {
            this.metrics?.increment("metadata.fetch.failure", 1, {
                reason: "error",
            });
            this.metrics?.histogram(
                "metadata.fetch.latency",
                Date.now() - start,
                { result: "error" },
            );
            logger.debug("Metadata fetch failed", {
                component: "MetadataFetcher",
                action: "fetchMetadata",
                uri,
                error: String(error),
            });
            return null;
        }
    }
}

async function fetchJson(
    uri: string,
    fetchResilience: HttpFetchResilienceConfig,
): Promise<unknown> {
    const response = await fetchWithHttpResilience({
        input: uri,
        config: fetchResilience,
        init: {
            headers: { accept: "application/json" },
        },
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

function parseDataUri(uri: string): unknown {
    return JSON.parse(parseJsonDataUriText(uri));
}

function normalizeMetadata(
    uri: string,
    raw: unknown,
    options: {
        imageSourceField: string | null;
        ipfsGatewayOrigin: string;
    },
): TokenMetadata | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    const attributes = normalizeAttributes(data.attributes);
    const imageSource = selectTokenMetadataImageSource({
        metadata: data,
        requestedField: options.imageSourceField,
        ipfsGatewayOrigin: options.ipfsGatewayOrigin,
    });

    return {
        uri,
        name: asString(data.name),
        description: asString(data.description),
        image: imageSource?.value,
        animationUrl: asString(data.animation_url ?? data.animationUrl),
        externalUrl: asString(data.external_url ?? data.externalUrl),
        attributes,
        rawJson: JSON.stringify(data),
    };
}

function normalizeAttributes(value: unknown): MetadataAttribute[] {
    if (!Array.isArray(value)) return [];
    const out: MetadataAttribute[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const traitType = asString(record.trait_type ?? record.traitType);
        const displayType = asString(record.display_type ?? record.displayType);
        const rawValue = record.value;
        if (
            rawValue === null ||
            rawValue === undefined ||
            typeof rawValue === "object"
        ) {
            continue;
        }
        out.push({
            traitType,
            displayType,
            value: rawValue as string | number | boolean,
        });
    }
    return out;
}

function asString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}
