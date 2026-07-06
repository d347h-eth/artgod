import {
    defaultImageCachePolicyConfig,
    normalizeImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "../media/token-image-cache.js";

export type { ImageCachePolicyConfig } from "../media/token-image-cache.js";

export const COLLECTION_CUSTOMIZATION_SOURCE_KIND = {
    User: "user",
    Extension: "extension",
} as const;

export type CollectionCustomizationSourceKind =
    (typeof COLLECTION_CUSTOMIZATION_SOURCE_KIND)[keyof typeof COLLECTION_CUSTOMIZATION_SOURCE_KIND];

export const COLLECTION_CUSTOMIZATION_FEATURE_KEY = {
    TraitFilterPresentation: "trait_filter_presentation",
    TokenCardTraitSummaryTemplate: "token_card_trait_summary_template",
    ActivityRowTraitSummaryTemplate: "activity_row_trait_summary_template",
    ImageCachePolicy: "image_cache_policy",
    MediaPurposePolicy: "media_purpose_policy",
} as const;

export type CollectionCustomizationFeatureKey =
    (typeof COLLECTION_CUSTOMIZATION_FEATURE_KEY)[keyof typeof COLLECTION_CUSTOMIZATION_FEATURE_KEY];

export const TRAIT_FILTER_DISPLAY_KIND = {
    Set: "set",
    Range: "range",
} as const;

export type TraitFilterDisplayKind =
    (typeof TRAIT_FILTER_DISPLAY_KIND)[keyof typeof TRAIT_FILTER_DISPLAY_KIND];

export type TraitFilterPresentationConfig = {
    rangeKeys: string[];
};

export type TraitFilterPresentationFeatureState = {
    selectedSource: CollectionCustomizationSourceKind;
    userConfig: TraitFilterPresentationConfig;
    extensionConfig: TraitFilterPresentationConfig | null;
    effectiveConfig: TraitFilterPresentationConfig;
    availableTraitKeys: string[];
};

export type TraitSummaryTemplateConfig = {
    template: string;
};

export type TraitSummaryTemplateFeatureState = {
    selectedSource: CollectionCustomizationSourceKind;
    userConfig: TraitSummaryTemplateConfig;
    extensionConfig: TraitSummaryTemplateConfig | null;
    effectiveConfig: TraitSummaryTemplateConfig;
};

export type ImageCachePolicyFeatureState = {
    selectedSource: CollectionCustomizationSourceKind;
    userConfig: ImageCachePolicyConfig;
    extensionConfig: ImageCachePolicyConfig | null;
    effectiveConfig: ImageCachePolicyConfig;
};

// Names canonical metadata media fields that collection presentation can prefer.
export const COLLECTION_MEDIA_SOURCE = {
    Image: "image",
    AnimationUrl: "animation_url",
} as const;

export type CollectionMediaSource =
    (typeof COLLECTION_MEDIA_SOURCE)[keyof typeof COLLECTION_MEDIA_SOURCE];

// Names frontend media purposes controlled by collection media policy.
export const COLLECTION_MEDIA_PURPOSE = {
    TokenCard: "token_card",
    FullscreenPreview: "fullscreen_preview",
    TokenDetail: "token_detail",
} as const;

export type CollectionMediaPurpose =
    (typeof COLLECTION_MEDIA_PURPOSE)[keyof typeof COLLECTION_MEDIA_PURPOSE];

export type MediaPurposePolicyConfig = {
    tokenCard: CollectionMediaSource;
    fullscreenPreview: CollectionMediaSource;
    tokenDetail: CollectionMediaSource;
};

export type MediaPurposePolicyFeatureState = {
    selectedSource: CollectionCustomizationSourceKind;
    userConfig: MediaPurposePolicyConfig;
    extensionConfig: MediaPurposePolicyConfig | null;
    effectiveConfig: MediaPurposePolicyConfig;
};

export type CollectionCustomization = {
    traitFilterPresentation: TraitFilterPresentationFeatureState;
    tokenCardTraitSummaryTemplate: TraitSummaryTemplateFeatureState;
    activityRowTraitSummaryTemplate: TraitSummaryTemplateFeatureState;
    imageCachePolicy: ImageCachePolicyFeatureState;
    mediaPurposePolicy: MediaPurposePolicyFeatureState;
};

export function defaultTraitFilterPresentationConfig(): TraitFilterPresentationConfig {
    return { rangeKeys: [] };
}

export function normalizeTraitFilterPresentationConfig(
    input: TraitFilterPresentationConfig | null | undefined,
): TraitFilterPresentationConfig {
    if (!input) {
        return defaultTraitFilterPresentationConfig();
    }

    const rangeKeys = normalizeTraitKeyList(input.rangeKeys);
    return { rangeKeys };
}

export function defaultTraitSummaryTemplateConfig(): TraitSummaryTemplateConfig {
    return { template: "" };
}

export function normalizeTraitSummaryTemplateConfig(
    input: TraitSummaryTemplateConfig | null | undefined,
): TraitSummaryTemplateConfig {
    if (!input || typeof input.template !== "string") {
        return defaultTraitSummaryTemplateConfig();
    }

    const trimmed = input.template.trim();
    return { template: trimmed };
}

export function defaultImageCachePolicyFeatureConfig(): ImageCachePolicyConfig {
    return defaultImageCachePolicyConfig();
}

export function normalizeImageCachePolicyFeatureConfig(
    input: ImageCachePolicyConfig | null | undefined,
): ImageCachePolicyConfig {
    return normalizeImageCachePolicyConfig(input);
}

// Returns the generic snapshot-media policy when no extension override exists.
export function defaultMediaPurposePolicyConfig(): MediaPurposePolicyConfig {
    return {
        tokenCard: COLLECTION_MEDIA_SOURCE.Image,
        fullscreenPreview: COLLECTION_MEDIA_SOURCE.Image,
        tokenDetail: COLLECTION_MEDIA_SOURCE.Image,
    };
}

// Normalizes persisted/user-provided media-purpose policy values.
export function normalizeMediaPurposePolicyConfig(
    input: MediaPurposePolicyConfig | null | undefined,
): MediaPurposePolicyConfig {
    if (!input) {
        return defaultMediaPurposePolicyConfig();
    }

    return {
        tokenCard: normalizeCollectionMediaSource(input.tokenCard),
        fullscreenPreview: normalizeCollectionMediaSource(
            input.fullscreenPreview,
        ),
        tokenDetail: normalizeCollectionMediaSource(input.tokenDetail),
    };
}

// Resolves which canonical media field should serve one frontend purpose.
export function mediaPurposePolicySourceForPurpose(
    config: MediaPurposePolicyConfig,
    purpose: CollectionMediaPurpose,
): CollectionMediaSource {
    if (purpose === COLLECTION_MEDIA_PURPOSE.TokenCard) {
        return config.tokenCard;
    }
    if (purpose === COLLECTION_MEDIA_PURPOSE.FullscreenPreview) {
        return config.fullscreenPreview;
    }
    return config.tokenDetail;
}

// Resolves whether user or extension customization config should be active.
export function resolveCollectionCustomizationSelectedSource(params: {
    requestedSource: CollectionCustomizationSourceKind | null;
    hasExtensionConfig: boolean;
}): CollectionCustomizationSourceKind {
    if (
        params.requestedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension
    ) {
        return params.hasExtensionConfig
            ? COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension
            : COLLECTION_CUSTOMIZATION_SOURCE_KIND.User;
    }

    if (params.requestedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.User) {
        return COLLECTION_CUSTOMIZATION_SOURCE_KIND.User;
    }

    return params.hasExtensionConfig
        ? COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension
        : COLLECTION_CUSTOMIZATION_SOURCE_KIND.User;
}

export function normalizeTraitKeyList(keys: string[] | null | undefined): string[] {
    if (!Array.isArray(keys)) {
        return [];
    }

    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const key of keys) {
        if (typeof key !== "string") {
            continue;
        }
        const trimmed = key.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        normalized.push(trimmed);
    }

    return normalized.sort((left, right) => left.localeCompare(right));
}

export function resolveTraitFilterDisplayKind(
    config: TraitFilterPresentationConfig,
    key: string,
): TraitFilterDisplayKind {
    return config.rangeKeys.includes(key)
        ? TRAIT_FILTER_DISPLAY_KIND.Range
        : TRAIT_FILTER_DISPLAY_KIND.Set;
}

function normalizeCollectionMediaSource(value: unknown): CollectionMediaSource {
    if (
        value === COLLECTION_MEDIA_SOURCE.Image ||
        value === COLLECTION_MEDIA_SOURCE.AnimationUrl
    ) {
        return value;
    }
    return COLLECTION_MEDIA_SOURCE.Image;
}

export function renderTraitSummaryTemplate(
    template: string,
    traits: Array<{ key: string; value: string }>,
): string | null {
    const normalized = normalizeTraitSummaryTemplateConfig({ template }).template;
    if (!normalized) {
        return null;
    }

    const traitValues = new Map<string, string>();
    for (const trait of traits) {
        const key = trait.key.trim();
        if (!key || traitValues.has(key)) {
            continue;
        }
        traitValues.set(key, trait.value);
    }

    const rendered = renderTraitSummaryPlaceholders(
        renderTraitSummaryConditionals(normalized, traitValues),
        traitValues,
    );

    const trimmed = rendered.trim();
    return trimmed ? trimmed : null;
}

function renderTraitSummaryConditionals(
    template: string,
    traitValues: ReadonlyMap<string, string>,
): string {
    return template.replace(
        /\{\{#if\s+([^{}]+?)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_match, rawCondition, conditionalTemplate) =>
            shouldRenderTraitSummaryConditional(rawCondition, traitValues)
                ? String(conditionalTemplate)
                : "",
    );
}

function shouldRenderTraitSummaryConditional(
    rawCondition: unknown,
    traitValues: ReadonlyMap<string, string>,
): boolean {
    if (typeof rawCondition !== "string") {
        return false;
    }

    const condition = rawCondition.trim();
    if (!condition) {
        return false;
    }

    const equalityIndex = condition.indexOf("=");
    if (equalityIndex >= 0) {
        const key = condition.slice(0, equalityIndex).trim();
        const expectedValue = condition.slice(equalityIndex + 1).trim();
        return key.length > 0 && traitValues.get(key) === expectedValue;
    }

    return (traitValues.get(condition) ?? "").trim().length > 0;
}

function renderTraitSummaryPlaceholders(
    template: string,
    traitValues: ReadonlyMap<string, string>,
): string {
    return template.replace(/\{([^}]+)\}/g, (_match, rawKey) => {
        const key = typeof rawKey === "string" ? rawKey.trim() : "";
        return key ? (traitValues.get(key) ?? "") : "";
    });
}
