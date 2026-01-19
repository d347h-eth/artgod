import { logger } from "@artgod/shared/utils";
import type { Metrics } from "../../metrics/types.js";
import type { MetadataFetcherPort } from "../../ports/metadata.js";
import type {
    MetadataAttribute,
    TokenMetadata,
} from "../../domain/metadata.js";

export type HttpMetadataFetcherConfig = {
    timeoutMs?: number;
    ipfsGateway?: string;
    metrics?: Metrics;
};

export class HttpMetadataFetcher implements MetadataFetcherPort {
    private timeoutMs: number;
    private ipfsGateway: string;
    private metrics?: Metrics;

    constructor(config: HttpMetadataFetcherConfig = {}) {
        this.timeoutMs = config.timeoutMs ?? 10_000;
        this.ipfsGateway = config.ipfsGateway ?? "https://ipfs.io/ipfs/";
        this.metrics = config.metrics;
    }

    async fetchMetadata(uri: string): Promise<TokenMetadata | null> {
        const resolved = resolveUri(uri, this.ipfsGateway);
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
                : await fetchJson(resolved, this.timeoutMs);
            const metadata = normalizeMetadata(uri, raw);
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

function resolveUri(uri: string, ipfsGateway: string): string | null {
    if (uri.startsWith("ipfs://")) {
        return ipfsGateway + uri.replace("ipfs://", "");
    }
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
        return uri;
    }
    if (uri.startsWith("data:")) {
        return uri;
    }
    return null;
}

async function fetchJson(uri: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(uri, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

function parseDataUri(uri: string): unknown {
    const match = uri.match(/^data:application\/json(;base64)?,(.*)$/i);
    if (!match) throw new Error("Unsupported data URI");
    const isBase64 = Boolean(match[1]);
    const payload = match[2] ?? "";
    const decoded = isBase64
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
    return JSON.parse(decoded);
}

function normalizeMetadata(uri: string, raw: unknown): TokenMetadata | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    const attributes = normalizeAttributes(data.attributes);

    return {
        uri,
        name: asString(data.name),
        description: asString(data.description),
        image: asString(data.image ?? data.image_url),
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
