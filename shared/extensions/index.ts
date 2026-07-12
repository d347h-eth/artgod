import { normalizeAddressRef } from "../utils/ref-resolver.js";

// Core collection media sources available without an installed extension.
export const COLLECTION_MEDIA_MODES = {
    Snapshot: "snapshot",
} as const;

// Core media source labels shared by collection and token presentation state.
export const COLLECTION_MEDIA_MODE_OPTIONS = {
    Snapshot: { key: COLLECTION_MEDIA_MODES.Snapshot, label: "snapshot" },
} as const;

// URL query keys that carry collection and token media selection state.
export const COLLECTION_MEDIA_QUERY_PARAMS = {
    MediaMode: "media_mode",
    MediaPreference: "media_preference",
    MediaVariant: "media_variant",
} as const;

// Generic query values used by extension-owned binary media preferences.
export const COLLECTION_MEDIA_PREFERENCE_VALUES = {
    Enabled: "enabled",
    Disabled: "disabled",
} as const;

export type CollectionExtensionKey = string;

export type CoreCollectionMediaMode =
    (typeof COLLECTION_MEDIA_MODES)[keyof typeof COLLECTION_MEDIA_MODES];

// Collection media sources remain open so installed extensions can own additional keys.
export type CollectionMediaMode = CoreCollectionMediaMode | (string & {});

// Describes one user-facing collection media source choice.
export type CollectionMediaModeOption = {
    key: CollectionMediaMode;
    label: string;
};

// Serialized query values for an extension-owned binary media preference.
export type CollectionMediaPreferenceValue =
    (typeof COLLECTION_MEDIA_PREFERENCE_VALUES)[keyof typeof COLLECTION_MEDIA_PREFERENCE_VALUES];

// Describes the effective optional preference shown on collection media surfaces.
export type CollectionMediaPreference = {
    label: string;
    enabled: boolean;
    defaultEnabled: boolean;
};

// Describes one exact media choice available for the current token and source.
export type TokenMediaVariantOption = {
    key: string;
    label: string;
};

// Collection media state carries only source and optional preference selection.
export type CollectionMediaPresentation = {
    selectedMode: CollectionMediaMode;
    defaultMode: CollectionMediaMode;
    availableModes: CollectionMediaModeOption[];
    preference: CollectionMediaPreference | null;
};

// Token media state adds the exact variant selected for the current token.
export type TokenMediaPresentation = CollectionMediaPresentation & {
    selectedVariant: string | null;
    defaultVariant: string | null;
    availableVariants: TokenMediaVariantOption[];
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
