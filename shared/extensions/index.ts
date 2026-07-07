import { normalizeAddressRef } from "../utils/ref-resolver.js";

export const COLLECTION_MEDIA_MODES = {
    Snapshot: "snapshot",
    Artifact: "artifact",
} as const;

export const COLLECTION_MEDIA_QUERY_PARAMS = {
    MediaMode: "media_mode",
} as const;

export type CollectionExtensionKey = string;

export type CoreCollectionMediaMode =
    (typeof COLLECTION_MEDIA_MODES)[keyof typeof COLLECTION_MEDIA_MODES];

export type CollectionMediaMode = CoreCollectionMediaMode | (string & {});

export type CollectionMediaModeOption = {
    key: CollectionMediaMode;
    label: string;
};

export type CollectionMediaPresentation = {
    selectedMode: CollectionMediaMode;
    defaultMode: CollectionMediaMode;
    availableModes: CollectionMediaModeOption[];
};

export type CollectionExtensionInstall = {
    chainId: number;
    collectionId: number;
    extensionKey: CollectionExtensionKey;
    enabled: boolean;
    configJson: string;
    createdAt: string;
    updatedAt: string;
};

export type EmbeddedCollectionExtensionInstall = {
    extensionKey: CollectionExtensionKey;
    configJson: string;
};

export const EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND = {
    AllContractTokens: "contract_all_tokens",
    TokenRange: "token_range",
    ExplicitTokenIds: "explicit_token_ids",
} as const;

export type EmbeddedCollectionExtensionScopeKind =
    (typeof EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND)[keyof typeof EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND];

export type EmbeddedCollectionExtensionScope =
    | {
          kind: typeof EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens;
      }
    | {
          kind: typeof EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange;
          startTokenId: string;
          totalSupply: number;
      }
    | {
          kind: typeof EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.ExplicitTokenIds;
          tokenIds: string[];
      };

export type EmbeddedCollectionExtensionMatch = {
    chainId: number;
    contractAddress: string;
    scope: EmbeddedCollectionExtensionScope;
    install: EmbeddedCollectionExtensionInstall;
};

export function resolveEmbeddedCollectionExtensionInstallFromMatches(input: {
    matches: readonly EmbeddedCollectionExtensionMatch[];
    chainId: number;
    contractAddress: string;
    scope: EmbeddedCollectionExtensionScope;
}): EmbeddedCollectionExtensionInstall | null {
    const normalizedAddress = normalizeAddressRef(input.contractAddress);
    const match = input.matches.find(
        (candidate) =>
            candidate.chainId === input.chainId &&
            candidate.contractAddress === normalizedAddress &&
            matchesEmbeddedScope(candidate.scope, input.scope),
    );
    return match?.install ?? null;
}

export function resolveEmbeddedCollectionExtensionInstallByKeyFromMatches(input: {
    matches: readonly EmbeddedCollectionExtensionMatch[];
    chainId: number;
    extensionKey: CollectionExtensionKey;
}): EmbeddedCollectionExtensionInstall | null {
    const match = input.matches.find(
        (candidate) =>
            candidate.chainId === input.chainId &&
            candidate.install.extensionKey === input.extensionKey,
    );
    return match?.install ?? null;
}

function matchesEmbeddedScope(
    left: EmbeddedCollectionExtensionScope,
    right: EmbeddedCollectionExtensionScope,
): boolean {
    if (left.kind !== right.kind) {
        return false;
    }

    if (
        left.kind === EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens
    ) {
        return true;
    }

    if (left.kind === EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange) {
        return (
            right.kind ===
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange &&
            left.startTokenId === right.startTokenId &&
            left.totalSupply === right.totalSupply
        );
    }

    return (
        right.kind ===
            EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.ExplicitTokenIds &&
        normalizedExplicitTokenIds(left.tokenIds).join(",") ===
            normalizedExplicitTokenIds(right.tokenIds).join(",")
    );
}

function normalizedExplicitTokenIds(tokenIds: string[]): string[] {
    return [...new Set(tokenIds)].sort((left, right) => {
        const leftValue = BigInt(left);
        const rightValue = BigInt(right);
        if (leftValue < rightValue) {
            return -1;
        }
        if (leftValue > rightValue) {
            return 1;
        }
        return 0;
    });
}
