import {
    resolveEmbeddedCollectionExtensionInstallByKeyFromMatches,
    resolveEmbeddedCollectionExtensionInstallFromMatches,
    type CollectionExtensionKey,
    type EmbeddedCollectionExtensionInstall,
    type EmbeddedCollectionExtensionMatch,
    type EmbeddedCollectionExtensionScope,
    type EmbeddedCollectionBootstrapPreset,
} from "./index.js";
import { TERRAFORMS_EMBEDDED_EXTENSION_MATCHES } from "./terraforms.js";
import { NFT111K_EMBEDDED_EXTENSION_MATCHES } from "./111k.js";
import { normalizeAddressRef } from "../utils/ref-resolver.js";

const BUILT_IN_COLLECTION_EXTENSION_MATCHES: readonly EmbeddedCollectionExtensionMatch[] =
    [
        ...TERRAFORMS_EMBEDDED_EXTENSION_MATCHES,
        ...NFT111K_EMBEDDED_EXTENSION_MATCHES,
    ];

/** Preflight has no selected scope or installation row. Admission matches both later. */
export function resolveEmbeddedCollectionBootstrapPreset(input: {
    chainId: number;
    contractAddress: string;
}): EmbeddedCollectionBootstrapPreset | null {
    const address = normalizeAddressRef(input.contractAddress);
    const match = BUILT_IN_COLLECTION_EXTENSION_MATCHES.find(
        (candidate) =>
            candidate.bootstrapPreset &&
            candidate.chainId === input.chainId &&
            candidate.contractAddress === address,
    );
    return match?.bootstrapPreset
        ? {
              extensionKey: match.install.extensionKey,
              scope: match.bootstrapPreset.scope,
          }
        : null;
}

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
