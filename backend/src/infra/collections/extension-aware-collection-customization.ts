import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    COLLECTION_CUSTOMIZATION_FEATURE_KEY,
    defaultTraitFilterPresentationConfig,
    defaultTraitSummaryTemplateConfig,
    normalizeTraitFilterPresentationConfig,
    normalizeTraitKeyList,
    normalizeTraitSummaryTemplateConfig,
    type CollectionCustomizationSourceKind,
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
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
        });
        const userConfig = parseTraitFilterPresentationConfigJson(
            record?.userConfigJson ?? null,
        );
        const selectedSource = resolveSelectedSource({
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
            availableTraitKeys: normalizeTraitKeyList([
                ...(params.availableTraitKeys ?? []),
                ...userConfig.rangeKeys,
                ...(extensionConfig?.rangeKeys ?? []),
            ]),
        };
    }

    updateTraitFilterPresentationState(params: {
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitFilterPresentationConfig;
        availableTraitKeys?: string[];
    }): TraitFilterPresentationFeatureState {
        const normalizedUserConfig = normalizeTraitFilterPresentationConfig(
            params.userConfig,
        );
        const currentState = this.getTraitFilterPresentationState({
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
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TraitFilterPresentation,
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getTraitFilterPresentationState({
            chainId: params.chainId,
            collectionId: params.collectionId,
            availableTraitKeys: params.availableTraitKeys,
        });
    }

    getTokenCardTraitSummaryTemplateState(params: {
        chainId: number;
        collectionId: number;
    }): TraitSummaryTemplateFeatureState {
        return resolveTraitSummaryTemplateFeatureState({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TokenCardTraitSummaryTemplate,
            extensionRecords: this.extensionRecords,
            customizationRecords: this.customizationRecords,
            extensionConfigResolver: (extension, install) =>
                extension.resolveTokenCardTraitSummaryTemplateConfig(install),
        });
    }

    updateTokenCardTraitSummaryTemplateState(params: {
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
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.TokenCardTraitSummaryTemplate,
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getTokenCardTraitSummaryTemplateState(params);
    }

    getActivityRowTraitSummaryTemplateState(params: {
        chainId: number;
        collectionId: number;
    }): TraitSummaryTemplateFeatureState {
        return resolveTraitSummaryTemplateFeatureState({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.ActivityRowTraitSummaryTemplate,
            extensionRecords: this.extensionRecords,
            customizationRecords: this.customizationRecords,
            extensionConfigResolver: (extension, install) =>
                extension.resolveActivityRowTraitSummaryTemplateConfig(install),
        });
    }

    updateActivityRowTraitSummaryTemplateState(params: {
        chainId: number;
        collectionId: number;
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitSummaryTemplateConfig;
    }): TraitSummaryTemplateFeatureState {
        const normalizedUserConfig = normalizeTraitSummaryTemplateConfig(
            params.userConfig,
        );
        const currentState = this.getActivityRowTraitSummaryTemplateState(params);
        assertExtensionConfigAvailable(
            params.selectedSource,
            currentState.extensionConfig,
            "Extension activity-row trait summary template unavailable",
        );

        this.customizationRecords.upsertFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            featureKey:
                COLLECTION_CUSTOMIZATION_FEATURE_KEY.ActivityRowTraitSummaryTemplate,
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getActivityRowTraitSummaryTemplateState(params);
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
    const selectedSource = resolveSelectedSource({
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

function assertExtensionConfigAvailable(
    selectedSource: CollectionCustomizationSourceKind,
    extensionConfig: TraitSummaryTemplateConfig | null,
    message: string,
): void {
    if (
        selectedSource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
        extensionConfig === null
    ) {
        throw new ReadModelBadRequestError(message);
    }
}

function resolveSelectedSource(params: {
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
