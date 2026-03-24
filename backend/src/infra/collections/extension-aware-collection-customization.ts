import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    defaultTraitFilterPresentationConfig,
    normalizeTraitFilterPresentationConfig,
    normalizeTraitKeyList,
    type CollectionCustomizationSourceKind,
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
    getTraitFilterPresentationFeature(params: {
        chainId: number;
        collectionId: number;
    }): {
        selectedSource: CollectionCustomizationSourceKind;
        userConfigJson: string;
    } | null;
    upsertTraitFilterPresentationFeature(params: {
        chainId: number;
        collectionId: number;
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
        const record = this.customizationRecords.getTraitFilterPresentationFeature(
            {
                chainId: params.chainId,
                collectionId: params.collectionId,
            },
        );
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

        this.customizationRecords.upsertTraitFilterPresentationFeature({
            chainId: params.chainId,
            collectionId: params.collectionId,
            selectedSource: params.selectedSource,
            userConfigJson: JSON.stringify(normalizedUserConfig),
        });

        return this.getTraitFilterPresentationState({
            chainId: params.chainId,
            collectionId: params.collectionId,
            availableTraitKeys: params.availableTraitKeys,
        });
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
