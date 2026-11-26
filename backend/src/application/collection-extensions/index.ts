import {
    NFT111K_EXTENSION_KEY,
    nft111kTraitCatalog,
} from "@artgod/shared/extensions/111k";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import type { TraitCatalogMapper } from "@artgod/shared/types/trait-catalog";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import { terraformsBackendCollectionExtension } from "./terraforms.js";
import type { BackendCollectionExtension } from "./types.js";

const BACKEND_COLLECTION_EXTENSIONS: Record<
    string,
    | {
          presentation?: BackendCollectionExtension;
          traitCatalog?: TraitCatalogMapper;
      }
    | undefined
> = {
    [TERRAFORMS_EXTENSION_KEY]: {
        presentation: terraformsBackendCollectionExtension,
    },
    [NFT111K_EXTENSION_KEY]: { traitCatalog: nft111kTraitCatalog },
};

export function resolveBackendCollectionExtension(
    install: CollectionExtensionInstall,
): BackendCollectionExtension | null {
    return (
        BACKEND_COLLECTION_EXTENSIONS[install.extensionKey]?.presentation ??
        null
    );
}

// Trait-only extensions use the core media and customization presentation.
export function resolveCollectionTraitMapper(
    extensions: readonly { key: string }[],
) {
    for (const extension of extensions) {
        const mapper =
            BACKEND_COLLECTION_EXTENSIONS[extension.key]?.traitCatalog;
        if (mapper) return mapper;
    }
    return null;
}
