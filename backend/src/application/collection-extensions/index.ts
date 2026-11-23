import {
    NFT111K_EXTENSION_KEY,
    nft111kTraitCatalog,
} from "@artgod/shared/extensions/111k";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import { terraformsBackendCollectionExtension } from "./terraforms.js";
import type { BackendCollectionExtension } from "./types.js";

const BACKEND_COLLECTION_EXTENSIONS: Record<
    string,
    BackendCollectionExtension | undefined
> = {
    [TERRAFORMS_EXTENSION_KEY]: terraformsBackendCollectionExtension,
};

export function resolveBackendCollectionExtension(
    install: CollectionExtensionInstall,
): BackendCollectionExtension | null {
    return BACKEND_COLLECTION_EXTENSIONS[install.extensionKey] ?? null;
}

// Trait-only extensions use the core media and customization presentation.
export function resolveCollectionTraitMapper(
    extensions: readonly { key: string }[],
) {
    return extensions.some(
        (extension) => extension.key === NFT111K_EXTENSION_KEY,
    )
        ? nft111kTraitCatalog
        : null;
}
