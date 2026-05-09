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
