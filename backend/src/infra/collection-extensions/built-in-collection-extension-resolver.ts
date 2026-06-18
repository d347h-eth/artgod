import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";
import {
    resolveEmbeddedCollectionExtensionInstall,
    resolveEmbeddedCollectionExtensionInstallByKey,
} from "@artgod/shared/extensions/built-ins";
import {
    normalizeImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { resolveBackendCollectionExtension } from "../../application/collection-extensions/index.js";
import type {
    EmbeddedCollectionExtensionResolveInput,
    EmbeddedCollectionExtensionResolverPort,
} from "../../application/use-cases/bootstrap/create-bootstrap-run.js";

// Collection id used only when previewing extension policy before bootstrap creates a collection row.
const IMAGE_CACHE_POLICY_PREVIEW_COLLECTION_ID = 0;

export class BuiltInCollectionExtensionResolver
    implements EmbeddedCollectionExtensionResolverPort
{
    resolveExtensionKey(
        input: EmbeddedCollectionExtensionResolveInput,
    ): CollectionExtensionKey | null {
        const install = resolveEmbeddedCollectionExtensionInstall(input);
        return install?.extensionKey ?? null;
    }

    resolveImageCachePolicyConfig(input: {
        chainId: number;
        collectionId?: number;
        extensionKey: CollectionExtensionKey;
    }): ImageCachePolicyConfig | null {
        const embedded = resolveEmbeddedCollectionExtensionInstallByKey(input);
        if (!embedded) {
            return null;
        }
        const install: CollectionExtensionInstall = {
            chainId: input.chainId,
            collectionId:
                input.collectionId ?? IMAGE_CACHE_POLICY_PREVIEW_COLLECTION_ID,
            extensionKey: embedded.extensionKey,
            enabled: true,
            configJson: embedded.configJson,
            createdAt: "",
            updatedAt: "",
        };
        const extension = resolveBackendCollectionExtension(install);
        if (!extension) {
            return null;
        }
        return normalizeImageCachePolicyConfig(
            extension.resolveImageCachePolicyConfig(install),
        );
    }
}
