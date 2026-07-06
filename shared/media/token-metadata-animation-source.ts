import { resolveTokenResourceUri } from "./token-resource-uri.js";

// Metadata field names commonly used as token animation or generator sources.
export const TOKEN_METADATA_ANIMATION_SOURCE_FIELD = {
    AnimationUrl: "animation_url",
    AnimationUrlCamel: "animationUrl",
    GeneratorUrl: "generator_url",
    GeneratorUrlCamel: "generatorUrl",
} as const;

export type TokenMetadataAnimationSourceField =
    (typeof TOKEN_METADATA_ANIMATION_SOURCE_FIELD)[keyof typeof TOKEN_METADATA_ANIMATION_SOURCE_FIELD];

// Preferred animation fields are tried before generator-url fallbacks.
export const TOKEN_METADATA_PREFERRED_ANIMATION_SOURCE_FIELDS = [
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl,
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrlCamel,
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrl,
    TOKEN_METADATA_ANIMATION_SOURCE_FIELD.GeneratorUrlCamel,
] as const;

export type TokenMetadataAnimationSourceSelection = {
    field: string;
    value: string;
};

export type TokenMetadataAnimationSourceSelectionInput = {
    metadata: Record<string, unknown>;
    requestedField?: string | null;
    ipfsGatewayOrigin?: string;
};

// Selects the metadata field that should populate canonical token animation media.
export function selectTokenMetadataAnimationSource(
    input: TokenMetadataAnimationSourceSelectionInput,
): TokenMetadataAnimationSourceSelection | null {
    const requestedField = normalizeTokenMetadataAnimationSourceField(
        input.requestedField,
    );
    if (requestedField) {
        return selectField(input.metadata, requestedField, input);
    }

    for (const field of TOKEN_METADATA_PREFERRED_ANIMATION_SOURCE_FIELDS) {
        const selection = selectField(input.metadata, field, input);
        if (selection) return selection;
    }
    return null;
}

// Normalizes user-entered animation field names without changing their spelling.
export function normalizeTokenMetadataAnimationSourceField(
    value: string | null | undefined,
): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function selectField(
    metadata: Record<string, unknown>,
    field: string,
    input: TokenMetadataAnimationSourceSelectionInput,
): TokenMetadataAnimationSourceSelection | null {
    const source = normalizeMetadataAnimationSourceValue(
        metadata[field],
        input,
    );
    return source ? { field, value: source } : null;
}

function normalizeMetadataAnimationSourceValue(
    value: unknown,
    input: TokenMetadataAnimationSourceSelectionInput,
): string | null {
    if (typeof value !== "string") return null;
    const source = value.trim();
    if (!source) return null;
    return resolveTokenResourceUri(source, {
        ipfsGatewayOrigin: input.ipfsGatewayOrigin,
    })
        ? source
        : null;
}
