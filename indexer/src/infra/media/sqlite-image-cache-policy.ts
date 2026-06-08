import { db } from "@artgod/shared/database";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import {
    COLLECTION_CUSTOMIZATION_FEATURE_KEY,
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    normalizeImageCachePolicyFeatureConfig,
    resolveCollectionCustomizationSelectedSource,
    type CollectionCustomizationSourceKind,
} from "@artgod/shared/types";
import type { ImageCachePolicyConfig } from "@artgod/shared/media/token-image-cache";
import { resolveIndexerCollectionExtension } from "../../application/collection-extensions/index.js";

type ImageCachePolicyFeatureRow = {
    selected_source: CollectionCustomizationSourceKind;
    user_config_json: string;
};

export class SqliteImageCachePolicyResolver {
    private readonly selectFeatureStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        featureKey: string;
    }>(
        "SELECT selected_source, user_config_json " +
            "FROM collection_customization_features " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND feature_key = @featureKey LIMIT 1",
    );

    constructor(
        private readonly collectionExtensionInstalls: {
            getInstall(
                chainId: number,
                collectionId: number,
            ): CollectionExtensionInstall | null;
        },
    ) {}

    getImageCachePolicyConfig(input: {
        chainId: number;
        collectionId: number;
    }): ImageCachePolicyConfig {
        const install = this.collectionExtensionInstalls.getInstall(
            input.chainId,
            input.collectionId,
        );
        const extensionConfig = resolveExtensionConfig(install);
        const row = this.selectFeatureStmt.get({
            chainId: input.chainId,
            collectionId: input.collectionId,
            featureKey: COLLECTION_CUSTOMIZATION_FEATURE_KEY.ImageCachePolicy,
        }) as ImageCachePolicyFeatureRow | undefined;
        const userConfig = parseUserConfig(row?.user_config_json ?? null);
        const selectedSource = resolveCollectionCustomizationSelectedSource({
            requestedSource: row?.selected_source ?? null,
            hasExtensionConfig: extensionConfig !== null,
        });

        return selectedSource ===
            COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension && extensionConfig
            ? extensionConfig
            : userConfig;
    }
}

function resolveExtensionConfig(
    install: CollectionExtensionInstall | null,
): ImageCachePolicyConfig | null {
    if (!install?.enabled) {
        return null;
    }
    const extension = resolveIndexerCollectionExtension(install);
    const config = extension?.resolveImageCachePolicyConfig?.(install) ?? null;
    return config ? normalizeImageCachePolicyFeatureConfig(config) : null;
}

function parseUserConfig(raw: string | null): ImageCachePolicyConfig {
    if (!raw) {
        return normalizeImageCachePolicyFeatureConfig(null);
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object"
            ? normalizeImageCachePolicyFeatureConfig(
                  parsed as ImageCachePolicyConfig,
              )
            : normalizeImageCachePolicyFeatureConfig(null);
    } catch {
        return normalizeImageCachePolicyFeatureConfig(null);
    }
}
