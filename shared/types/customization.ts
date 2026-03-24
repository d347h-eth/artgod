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

export type CollectionCustomization = {
    traitFilterPresentation: TraitFilterPresentationFeatureState;
    tokenCardTraitSummaryTemplate: TraitSummaryTemplateFeatureState;
    activityRowTraitSummaryTemplate: TraitSummaryTemplateFeatureState;
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

    const rendered = normalized.replace(/\{([^}]+)\}/g, (_match, rawKey) => {
        const key = typeof rawKey === "string" ? rawKey.trim() : "";
        return key ? (traitValues.get(key) ?? "") : "";
    });

    return rendered.trim() ? rendered : null;
}
