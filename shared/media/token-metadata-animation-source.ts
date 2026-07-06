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

// Selects the metadata field that should populate canonical token animation media.
export function selectTokenMetadataAnimationSource(
    metadata: Record<string, unknown>,
): string | null {
    for (const field of TOKEN_METADATA_PREFERRED_ANIMATION_SOURCE_FIELDS) {
        const source = normalizeMetadataAnimationSourceValue(metadata[field]);
        if (source) return source;
    }
    return null;
}

function normalizeMetadataAnimationSourceValue(value: unknown): string | null {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return null;
}
