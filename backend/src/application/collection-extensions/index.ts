import {
    COLLECTION_EXTENSION_KEYS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import { terraformsBackendCollectionExtension } from "./terraforms.js";
import type { BackendCollectionExtension } from "./types.js";

const BACKEND_COLLECTION_EXTENSIONS: Record<
    string,
    BackendCollectionExtension | undefined
> = {
    [COLLECTION_EXTENSION_KEYS.Terraforms]:
        terraformsBackendCollectionExtension,
};

export function resolveBackendCollectionExtension(
    install: CollectionExtensionInstall,
): BackendCollectionExtension | null {
    return BACKEND_COLLECTION_EXTENSIONS[install.extensionKey] ?? null;
}
