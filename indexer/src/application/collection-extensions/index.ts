import {
    COLLECTION_EXTENSION_KEYS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type { IndexerCollectionExtension } from "./types.js";
import { terraformsIndexerExtension } from "./terraforms.js";

const INDEXER_COLLECTION_EXTENSIONS: Record<
    string,
    IndexerCollectionExtension | undefined
> = {
    [COLLECTION_EXTENSION_KEYS.Terraforms]: terraformsIndexerExtension,
};

export function resolveIndexerCollectionExtension(
    install: CollectionExtensionInstall,
): IndexerCollectionExtension | null {
    return INDEXER_COLLECTION_EXTENSIONS[install.extensionKey] ?? null;
}
