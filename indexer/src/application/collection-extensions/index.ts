import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import type { IndexerCollectionExtension } from "./types.js";
import { terraformsIndexerExtension } from "./terraforms.js";

const INDEXER_COLLECTION_EXTENSIONS: Record<
    string,
    IndexerCollectionExtension | undefined
> = {
    [TERRAFORMS_EXTENSION_KEY]: terraformsIndexerExtension,
};

export function resolveIndexerCollectionExtension(
    install: CollectionExtensionInstall,
): IndexerCollectionExtension | null {
    return INDEXER_COLLECTION_EXTENSIONS[install.extensionKey] ?? null;
}
