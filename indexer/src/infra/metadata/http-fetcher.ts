import { logger } from "@artgod/shared/utils";
import type { Metrics } from "@artgod/shared/observability/metrics";
import type { MetadataFetcherPort } from "../../ports/metadata.js";
import {
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD,
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD_FRAGMENT,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD,
    type MetadataAttribute,
    type TokenMetadata,
} from "../../domain/metadata.js";
import {
    parseJsonDataUriText,
    resolveTokenResourceUri,
} from "@artgod/shared/media/token-resource-uri";
import { selectTokenMetadataAnimationSource } from "@artgod/shared/media/token-metadata-animation-source";
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
    const attributes = normalizeMetadataAttributes(data);
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
        animationUrl: selectTokenMetadataAnimationSource(data) ?? undefined,
        externalUrl: asString(data.external_url ?? data.externalUrl),
        attributes,
        rawJson: JSON.stringify(data),
    };
}

function normalizeMetadataAttributes(
    data: Record<string, unknown>,
): MetadataAttribute[] {
    return (
        normalizeAttributes(
            data[TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Attributes],
            { allowGenericTraitKeys: false },
        ) ??
        normalizeAttributes(
            data[TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Traits],
            { allowGenericTraitKeys: false },
        ) ??
        normalizeAttributeObjectMap(
            data[TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Features],
        ) ??
        normalizeHeuristicAttributes(data)
    );
}

function normalizeHeuristicAttributes(
    data: Record<string, unknown>,
): MetadataAttribute[] {
    for (const [fieldName, value] of Object.entries(data)) {
        if (isKnownAttributeContainerField(fieldName)) continue;
        const allowGenericTraitKeys =
            isLikelyAttributeContainerFieldName(fieldName);
        if (allowGenericTraitKeys) {
            const objectMapAttributes = normalizeAttributeObjectMap(value);
            if (objectMapAttributes) {
                return objectMapAttributes;
            }
        }
        if (
            !allowGenericTraitKeys &&
            !hasExplicitTraitKeyAttributeCandidate(value)
        ) {
            continue;
        }
        const attributes = normalizeAttributes(value, {
            allowGenericTraitKeys,
        });
        if (attributes) {
            return attributes;
        }
    }
    return [];
}

function normalizeAttributes(
    value: unknown,
    options: { allowGenericTraitKeys: boolean },
): MetadataAttribute[] | null {
    if (!Array.isArray(value)) return null;
    const out: MetadataAttribute[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const traitType = asString(
            firstDefined(record, ATTRIBUTE_TRAIT_TYPE_FIELD_PRIORITY) ??
                (options.allowGenericTraitKeys
                    ? firstDefined(record, GENERIC_ATTRIBUTE_TRAIT_TYPE_FIELD_PRIORITY)
                    : undefined),
        );
        const displayType = asString(
            firstDefined(record, ATTRIBUTE_DISPLAY_TYPE_FIELD_PRIORITY),
        );
        const rawValue = firstDefined(record, ATTRIBUTE_VALUE_FIELD_PRIORITY);
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
    if (out.length === 0 || hasDuplicateTraitType(out)) {
        return null;
    }
    return out;
}

function normalizeAttributeObjectMap(value: unknown): MetadataAttribute[] | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const out: MetadataAttribute[] = [];
    for (const [key, rawValue] of Object.entries(
        value as Record<string, unknown>,
    )) {
        const traitType = key.trim();
        if (!traitType) continue;
        if (
            rawValue === null ||
            rawValue === undefined ||
            typeof rawValue === "object"
        ) {
            continue;
        }
        out.push({
            traitType,
            value: rawValue as string | number | boolean,
        });
    }
    return out.length > 0 ? out : null;
}

function hasDuplicateTraitType(attributes: readonly MetadataAttribute[]): boolean {
    const seen = new Set<string>();
    for (const attribute of attributes) {
        const traitType = attribute.traitType?.trim();
        if (!traitType) continue;
        if (seen.has(traitType)) return true;
        seen.add(traitType);
    }
    return false;
}

function asString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}

function firstDefined(
    record: Record<string, unknown>,
    fields: readonly TokenMetadataAttributeItemField[],
): unknown {
    for (const field of fields) {
        if (record[field] !== undefined) {
            return record[field];
        }
    }
    return undefined;
}

function hasExplicitTraitKeyAttributeCandidate(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return value.some((item) => {
        if (!item || typeof item !== "object") return false;
        const record = item as Record<string, unknown>;
        return (
            firstDefined(record, ATTRIBUTE_TRAIT_TYPE_FIELD_PRIORITY) !==
                undefined &&
            firstDefined(record, ATTRIBUTE_VALUE_FIELD_PRIORITY) !== undefined
        );
    });
}

function isKnownAttributeContainerField(fieldName: string): boolean {
    return (
        fieldName === TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Attributes ||
        fieldName === TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Features ||
        fieldName === TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD.Traits
    );
}

function isLikelyAttributeContainerFieldName(fieldName: string): boolean {
    const normalized = fieldName.toLowerCase();
    return ATTRIBUTE_CONTAINER_FIELD_FRAGMENTS.some((fragment) =>
        normalized.includes(fragment),
    );
}

type TokenMetadataAttributeItemField = ValueOf<
    typeof TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD
>;

type ValueOf<T> = T[keyof T];

const ATTRIBUTE_TRAIT_TYPE_FIELD_PRIORITY = [
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitType,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitTypeCamel,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Trait,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitName,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitNameCamel,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.AttributeType,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.AttributeTypeCamel,
] as const;

const GENERIC_ATTRIBUTE_TRAIT_TYPE_FIELD_PRIORITY = [
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Type,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Key,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Name,
] as const;

const ATTRIBUTE_DISPLAY_TYPE_FIELD_PRIORITY = [
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.DisplayType,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.DisplayTypeCamel,
] as const;

const ATTRIBUTE_VALUE_FIELD_PRIORITY = [
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.Value,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitValue,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.TraitValueCamel,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.AttributeValue,
    TOKEN_METADATA_ATTRIBUTE_ITEM_FIELD.AttributeValueCamel,
] as const;

const ATTRIBUTE_CONTAINER_FIELD_FRAGMENTS = [
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD_FRAGMENT.Attribute,
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD_FRAGMENT.Feature,
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD_FRAGMENT.Trait,
    TOKEN_METADATA_ATTRIBUTE_CONTAINER_FIELD_FRAGMENT.Property,
] as const;
