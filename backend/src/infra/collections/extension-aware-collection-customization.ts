import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    COLLECTION_CUSTOMIZATION_FEATURE_KEY,
    defaultImageCachePolicyFeatureConfig,
    defaultMediaPurposePolicyConfig,
    defaultTraitFilterPresentationConfig,
    defaultTraitSummaryTemplateConfig,
    normalizeImageCachePolicyFeatureConfig,
    normalizeMediaPurposePolicyConfig,
    normalizeTraitFilterPresentationConfig,
    normalizeTraitKeyList,
    normalizeTraitSummaryTemplateConfig,
    resolveCollectionCustomizationSelectedSource,
    type CollectionCustomizationSourceKind,
    type ImageCachePolicyFeatureState,
    type ImageCachePolicyConfig,
    type MediaPurposePolicyFeatureState,
    type MediaPurposePolicyConfig,
    type TraitSummaryTemplateConfig,
    type TraitSummaryTemplateFeatureState,
    type TraitFilterPresentationConfig,
    type TraitFilterPresentationFeatureState,
} from "@artgod/shared/types";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { resolveBackendCollectionExtension } from "../../application/collection-extensions/index.js";

type CollectionExtensionRecordsPort = {
    getInstallByCollectionId(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null;
};

type CollectionCustomizationRecordsPort = {
    getFeature(params: {
        chainId: number;
        collectionId: number;
        featureKey: string;
    }): {
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    } | null;
    upsertFeature(params: {
        chainId: number;
        collectionId: number;
        featureKey: string;
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    }): void;
};

export class ExtensionAwareCollectionCustomization {
    constructor(
        private readonly extensionRecords: CollectionExtensionRecordsPort,
        private readonly customizationRecords: CollectionCustomizationRecordsPort,
    ) {}

    getTraitFilterPresentationState(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
        availableTraitKeys?: string[];
    }): TraitFilterPresentationFeatureState {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extensionConfig =
            this.resolveExtensionTraitFilterPresentationConfig(install);
        const record = this.customizationRecords.getFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: scopedFeatureKey(
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
                params.traitContext,
            ),
        });
        const savedConfig = parseTraitFilterPresentationConfigJson(
            record?.userConfigJson ?? null,
        );
        // A rebuilt catalog may stop exposing a formerly flat field. The picker
        // and active range keys reflect the currently published fields of this view.
        const available =
            params.traitContext && params.availableTraitKeys
                ? new Set(params.availableTraitKeys)
                : null;
        const userConfig = available
            ? {
                  rangeKeys: savedConfig.rangeKeys.filter((key) =>
                      available.has(key),
                  ),
              }
            : savedConfig;
        const selectedSource = resolveCollectionCustomizationSelectedSource({
            requestedSource: record?.selectedSource ?? null,
            hasExtensionConfig: extensionConfig !== null,
        });
        const effectiveConfig =
            selectedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
            extensionConfig
                ? extensionConfig
                : userConfig;

        return {
            selectedSource,
            userConfig,
            extensionConfig,
            effectiveConfig,
            availableTraitKeys: available
                ? normalizeTraitKeyList([...available])
                : normalizeTraitKeyList([
                      ...(params.availableTraitKeys ?? []),
                      ...userConfig.rangeKeys,
                      ...(extensionConfig?.rangeKeys ?? []),
                  ]),
        };
    }

    updateTraitFilterPresentationState(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitFilterPresentationConfig;
        availableTraitKeys?: string[];
    }): TraitFilterPresentationFeatureState {
        const normalizedUserConfig = normalizeTraitFilterPresentationConfig(
            params.userConfig,
        );
        if (
            params.traitContext &&
            params.availableTraitKeys &&
            normalizedUserConfig.rangeKeys.some(
                (key) => !params.availableTraitKeys!.includes(key),
            )
        )
            throw new ReadModelBadRequestError(
                "Choose a range key from the selected catalog.",
            );
        const currentState = this.getTraitFilterPresentationState({
            traitContext: params.traitContext,
            chainId: params.chainId,
            collectionId: params.collectionId,
            availableTraitKeys: params.availableTraitKeys,
        });
        if (
            params.selectedSource ===
                COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
            currentState.extensionConfig === null
        ) {
            throw new ReadModelBadRequestError(
                "Extension trait filter configuration unavailable",
            );
        }

        this.customizationRecords.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: scopedFeatureKey(
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
                params.traitContext,
            ),
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getTraitFilterPresentationState({
            traitContext: params.traitContext,
            chainId: params.chainId,
            collectionId: params.collectionId,
            availableTraitKeys: params.availableTraitKeys,
        });
    }

    getTokenCardTraitSummaryTemplateState(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
    }): TraitSummaryTemplateFeatureState {
        return resolveTraitSummaryTemplateFeatureState({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: scopedFeatureKey(
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TokenCardTraitSummaryTemplate,
                params.traitContext,
            ),
            extensionRecords: this.extensionRecords,
            customizationRecords: this.customizationRecords,
            extensionConfigResolver: (extension, install) =>
                extension.resolveTokenCardTraitSummaryTemplateConfig(install),
        });
    }

    updateTokenCardTraitSummaryTemplateState(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitSummaryTemplateConfig;
    }): TraitSummaryTemplateFeatureState {
        const normalizedUserConfig = normalizeTraitSummaryTemplateConfig(
            params.userConfig,
        );
        const currentState = this.getTokenCardTraitSummaryTemplateState(params);
        assertExtensionConfigAvailable(
            params.selectedSource,
            currentState.extensionConfig,
            "Extension token-card trait summary template unavailable",
        );

        this.customizationRecords.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: scopedFeatureKey(
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TokenCardTraitSummaryTemplate,
                params.traitContext,
            ),
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getTokenCardTraitSummaryTemplateState(params);
    }

    getActivityRowTraitSummaryTemplateState(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
    }): TraitSummaryTemplateFeatureState {
        return resolveTraitSummaryTemplateFeatureState({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: scopedFeatureKey(
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.ActivityRowTraitSummaryTemplate,
                params.traitContext,
            ),
            extensionRecords: this.extensionRecords,
            customizationRecords: this.customizationRecords,
            extensionConfigResolver: (extension, install) =>
                extension.resolveActivityRowTraitSummaryTemplateConfig(install),
        });
    }

    getImageCachePolicyState(params: {
        chainId: number;
        collectionId: number;
    }): ImageCachePolicyFeatureState {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extensionConfig = resolveExtensionImageCachePolicyConfig(install);
        const record = this.customizationRecords.getFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: COLLECTION_CUSTOMIZATION_FEATURE_KEY.ImageCachePolicy,
        });
        const userConfig = parseImageCachePolicyConfigJson(
            record?.userConfigJson ?? null,
        );
        const selectedSource = resolveCollectionCustomizationSelectedSource({
            requestedSource: record?.selectedSource ?? null,
            hasExtensionConfig: extensionConfig !== null,
        });
        const effectiveConfig =
            selectedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
            extensionConfig
                ? extensionConfig
                : userConfig;

        return {
            selectedSource,
            userConfig,
            extensionConfig,
            effectiveConfig,
        };
    }

    getMediaPurposePolicyState(params: {
        chainId: number;
        collectionId: number;
    }): MediaPurposePolicyFeatureState {
        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extensionConfig =
            resolveExtensionMediaPurposePolicyConfig(install);
        const record = this.customizationRecords.getFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: COLLECTION_CUSTOMIZATION_FEATURE_KEY.MediaPurposePolicy,
        });
        const userConfig = parseMediaPurposePolicyConfigJson(
            record?.userConfigJson ?? null,
        );
        const selectedSource = resolveCollectionCustomizationSelectedSource({
            requestedSource: record?.selectedSource ?? null,
            hasExtensionConfig: extensionConfig !== null,
        });
        const effectiveConfig =
            selectedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
            extensionConfig
                ? extensionConfig
                : userConfig;

        return {
            selectedSource,
            userConfig,
            extensionConfig,
            effectiveConfig,
        };
    }

    updateActivityRowTraitSummaryTemplateState(params: {
        traitContext?: TraitReadContext;
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitSummaryTemplateConfig;
    }): TraitSummaryTemplateFeatureState {
        const normalizedUserConfig = normalizeTraitSummaryTemplateConfig(
            params.userConfig,
        );
        const currentState =
            this.getActivityRowTraitSummaryTemplateState(params);
        assertExtensionConfigAvailable(
            params.selectedSource,
            currentState.extensionConfig,
            "Extension activity-row trait summary template unavailable",
        );

        this.customizationRecords.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: scopedFeatureKey(
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.ActivityRowTraitSummaryTemplate,
                params.traitContext,
            ),
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getActivityRowTraitSummaryTemplateState(params);
    }

    updateImageCachePolicyState(params: {
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: ImageCachePolicyConfig;
    }): ImageCachePolicyFeatureState {
        const normalizedUserConfig = normalizeImageCachePolicyFeatureConfig(
            params.userConfig,
        );
        const currentState = this.getImageCachePolicyState(params);
        assertExtensionConfigAvailable(
            params.selectedSource,
            currentState.extensionConfig,
            "Extension image cache policy unavailable",
        );

        this.customizationRecords.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: COLLECTION_CUSTOMIZATION_FEATURE_KEY.ImageCachePolicy,
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getImageCachePolicyState(params);
    }

    updateMediaPurposePolicyState(params: {
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: MediaPurposePolicyConfig;
    }): MediaPurposePolicyFeatureState {
        const normalizedUserConfig = normalizeMediaPurposePolicyConfig(
            params.userConfig,
        );
        const currentState = this.getMediaPurposePolicyState(params);
        assertExtensionConfigAvailable(
            params.selectedSource,
            currentState.extensionConfig,
            "Extension media purpose policy unavailable",
        );

        this.customizationRecords.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey: COLLECTION_CUSTOMIZATION_FEATURE_KEY.MediaPurposePolicy,
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getMediaPurposePolicyState(params);
    }

    private resolveExtensionTraitFilterPresentationConfig(
        install: CollectionExtensionInstall | null,
    ): TraitFilterPresentationConfig | null {
        if (!install?.enabled) {
            return null;
        }

        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return null;
        }

        return normalizeTraitFilterPresentationConfig(
            extension.resolveTraitFilterPresentationConfig(install),
        );
    }
}

function parseTraitFilterPresentationConfigJson(
    raw: string | null,
): TraitFilterPresentationConfig {
    if (!raw) {
        return defaultTraitFilterPresentationConfig();
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") {
            return defaultTraitFilterPresentationConfig();
        }
        return normalizeTraitFilterPresentationConfig(
            parsed as TraitFilterPresentationConfig,
        );
    } catch {
        return defaultTraitFilterPresentationConfig();
    }
}

function parseTraitSummaryTemplateConfigJson(
    raw: string | null,
): TraitSummaryTemplateConfig {
    if (!raw) {
        return defaultTraitSummaryTemplateConfig();
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") {
            return defaultTraitSummaryTemplateConfig();
        }
        return normalizeTraitSummaryTemplateConfig(
            parsed as TraitSummaryTemplateConfig,
        );
    } catch {
        return defaultTraitSummaryTemplateConfig();
    }
}

function parseImageCachePolicyConfigJson(
    raw: string | null,
): ImageCachePolicyConfig {
    if (!raw) {
        return defaultImageCachePolicyFeatureConfig();
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") {
            return defaultImageCachePolicyFeatureConfig();
        }
        return normalizeImageCachePolicyFeatureConfig(
            parsed as ImageCachePolicyConfig,
        );
    } catch {
        return defaultImageCachePolicyFeatureConfig();
    }
}

function parseMediaPurposePolicyConfigJson(
    raw: string | null,
): MediaPurposePolicyConfig {
    if (!raw) {
        return defaultMediaPurposePolicyConfig();
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") {
            return defaultMediaPurposePolicyConfig();
        }
        return normalizeMediaPurposePolicyConfig(
            parsed as MediaPurposePolicyConfig,
        );
    } catch {
        return defaultMediaPurposePolicyConfig();
    }
}

function resolveTraitSummaryTemplateFeatureState(params: {
    chainId: number;
    collectionId: number;
    featureKey: string;
    extensionRecords: CollectionExtensionRecordsPort;
    customizationRecords: CollectionCustomizationRecordsPort;
    extensionConfigResolver: (
        extension: NonNullable<
            ReturnType<typeof resolveBackendCollectionExtension>
        >,
        install: CollectionExtensionInstall,
    ) => TraitSummaryTemplateConfig | null;
}): TraitSummaryTemplateFeatureState {
    const install = params.extensionRecords.getInstallByCollectionId(
        params.chainId,
        params.collectionId,
    );
    const extensionConfig = resolveExtensionTraitSummaryTemplateConfig({
        install,
        extensionConfigResolver: params.extensionConfigResolver,
    });
    const record = params.customizationRecords.getFeature({
        chainId: params.chainId,
        collectionId: params.collectionId,
        featureKey: params.featureKey,
    });
    const userConfig = parseTraitSummaryTemplateConfigJson(
        record?.userConfigJson ?? null,
    );
    const selectedSource = resolveCollectionCustomizationSelectedSource({
        requestedSource: record?.selectedSource ?? null,
        hasExtensionConfig: extensionConfig !== null,
    });
    const effectiveConfig =
        selectedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
        extensionConfig
            ? extensionConfig
            : userConfig;

    return {
        selectedSource,
        userConfig,
        extensionConfig,
        effectiveConfig,
    };
}

function resolveExtensionTraitSummaryTemplateConfig(params: {
    install: CollectionExtensionInstall | null;
    extensionConfigResolver: (
        extension: NonNullable<
            ReturnType<typeof resolveBackendCollectionExtension>
        >,
        install: CollectionExtensionInstall,
    ) => TraitSummaryTemplateConfig | null;
}): TraitSummaryTemplateConfig | null {
    if (!params.install?.enabled) {
        return null;
    }

    const extension = resolveBackendCollectionExtension(params.install);
    if (!extension) {
        return null;
    }

    return normalizeTraitSummaryTemplateConfig(
        params.extensionConfigResolver(extension, params.install),
    );
}

function resolveExtensionImageCachePolicyConfig(
    install: CollectionExtensionInstall | null,
): ImageCachePolicyConfig | null {
    if (!install?.enabled) {
        return null;
    }

    const extension = resolveBackendCollectionExtension(install);
    if (!extension) {
        return null;
    }

    return normalizeImageCachePolicyFeatureConfig(
        extension.resolveImageCachePolicyConfig(install),
    );
}

function resolveExtensionMediaPurposePolicyConfig(
    install: CollectionExtensionInstall | null,
): MediaPurposePolicyConfig | null {
    if (!install?.enabled) {
        return null;
    }

    const extension = resolveBackendCollectionExtension(install);
    if (!extension) {
        return null;
    }

    const config = extension.resolveMediaPurposePolicyConfig(install);
    return config ? normalizeMediaPurposePolicyConfig(config) : null;
}

function assertExtensionConfigAvailable(
    selectedSource: CollectionCustomizationSourceKind,
    extensionConfig: unknown | null,
    message: string,
): void {
    if (
        selectedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
        extensionConfig === null
    ) {
        throw new ReadModelBadRequestError(message);
    }
}

/** Preserve a view's settings across generation rebuilds. */
function scopedFeatureKey(key: string, context?: TraitReadContext): string {
    if (context?.groupId)
        return JSON.stringify([key, context.catalog, null, context.groupId]);
    return context
        ? JSON.stringify([key, context.catalog, context.viewId])
        : key;
}
