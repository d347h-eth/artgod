import {
    resolveEmbeddedCollectionExtensionInstallByKeyFromMatches,
    resolveEmbeddedCollectionExtensionInstallFromMatches,
    type CollectionExtensionKey,
    type EmbeddedCollectionExtensionInstall,
    type EmbeddedCollectionExtensionMatch,
    type EmbeddedCollectionExtensionScope,
} from "./index.js";
import { TERRAFORMS_EMBEDDED_EXTENSION_MATCHES } from "./terraforms.js";

const BUILT_IN_COLLECTION_EXTENSION_MATCHES: readonly EmbeddedCollectionExtensionMatch[] =
    [...TERRAFORMS_EMBEDDED_EXTENSION_MATCHES];

export function resolveEmbeddedCollectionExtensionInstall(input: {
    chainId: number;
    contractAddress: string;
    scope: EmbeddedCollectionExtensionScope;
}): EmbeddedCollectionExtensionInstall | null {
    return resolveEmbeddedCollectionExtensionInstallFromMatches({
        matches: BUILT_IN_COLLECTION_EXTENSION_MATCHES,
        ...input,
    });
}

export function resolveEmbeddedCollectionExtensionInstallByKey(input: {
    chainId: number;
    extensionKey: CollectionExtensionKey;
}): EmbeddedCollectionExtensionInstall | null {
    return resolveEmbeddedCollectionExtensionInstallByKeyFromMatches({
        matches: BUILT_IN_COLLECTION_EXTENSION_MATCHES,
        ...input,
    });
}
