import type {
    CollectionExtensionKey,
    CollectionExtensionInstall,
    CollectionMediaMode,
    CollectionMediaPreference,
    CollectionMediaPreferenceValue,
    CollectionMediaModeOption,
    TokenMediaPresentation,
} from "@artgod/shared/extensions";
import type {
    ActivityExtensionEventFeed,
    TraitFilterPresentationConfig,
    TraitSummaryTemplateConfig,
    MediaPurposePolicyConfig,
} from "@artgod/shared/types";
import type { ImageCachePolicyConfig } from "@artgod/shared/media/token-image-cache";
import type {
    TokenCard,
    TokenDetail,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

export type BackendRpcHex = `0x${string}`;

export type BackendCollectionExtensionArtifactRecord = {
    extensionKey: CollectionExtensionKey;
    artifactRef: string;
    image: string | null;
    animationUrl: string | null;
    htmlContent: string | null;
};

export type BackendCollectionExtensionMediaContext = {
    mediaMode: CollectionMediaMode;
    mediaVariant: string | null;
    artifact: BackendCollectionExtensionArtifactRecord | null;
    rpc?: BackendCollectionExtensionRenderContext["rpc"];
};

// Exposes canonical token facts needed for extension-owned media selection.
export type BackendCollectionExtensionCanonicalMediaFacts = {
    isCanonicalToken: boolean;
    animationUrl: string | null;
    getAttributeValue(key: string): string | null;
};

// Carries canonical media facts from the persistence adapter into extension reads.
export type BackendCollectionExtensionCanonicalMediaRecord = {
    isCanonicalToken: boolean;
    animationUrl: string | null;
    attributes: ReadonlyMap<string, string>;
};

// Supplies one token's requested and available media state to an extension.
export type BackendCollectionExtensionTokenMediaContext = {
    tokenId: string;
    requestedMode?: CollectionMediaMode;
    requestedPreference?: CollectionMediaPreferenceValue;
    requestedVariant?: string;
    canonical: BackendCollectionExtensionCanonicalMediaFacts;
    getArtifact(
        artifactRef: string,
    ): BackendCollectionExtensionArtifactRecord | null;
    rpc?: BackendCollectionExtensionRenderContext["rpc"];
};

export type BackendCollectionExtensionActivityEventContext = {
    activityId: number;
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    blockNumber: number | null;
    txHash: string | null;
    logIndex: number | null;
    payload: Record<string, unknown> | null;
};

export type BackendCollectionExtensionRenderContext = {
    renderMode?: string;
    rpc: {
        readContract<T = unknown>(params: {
            address: BackendRpcHex;
            abi: readonly unknown[];
            functionName: string;
            args?: readonly unknown[];
            blockNumber?: number;
        }): Promise<T>;
        getStorageAt(params: {
            address: BackendRpcHex;
            slot: BackendRpcHex;
            blockNumber?: number;
        }): Promise<BackendRpcHex | null>;
        getCurrentBlockNumber(): Promise<number>;
        getBlockTimestamp(blockNumber: number): Promise<number>;
    };
};

export type BackendCollectionExtensionTokenUriContext =
    BackendCollectionExtensionRenderContext;

export interface BackendCollectionExtension {
    key: CollectionExtensionKey;
    resolveTraitFilterPresentationConfig(
        install: CollectionExtensionInstall,
    ): TraitFilterPresentationConfig | null;
    resolveTokenCardTraitSummaryTemplateConfig(
        install: CollectionExtensionInstall,
    ): TraitSummaryTemplateConfig | null;
    resolveActivityRowTraitSummaryTemplateConfig(
        install: CollectionExtensionInstall,
    ): TraitSummaryTemplateConfig | null;
    resolveImageCachePolicyConfig(
        install: CollectionExtensionInstall,
    ): ImageCachePolicyConfig | null;
    resolveMediaPurposePolicyConfig(
        install: CollectionExtensionInstall,
    ): MediaPurposePolicyConfig | null;
    listActivityEventFeeds(
        install: CollectionExtensionInstall,
    ): ActivityExtensionEventFeed[];
    listMediaModes(
        install: CollectionExtensionInstall,
    ): CollectionMediaModeOption[];
    defaultMediaMode(install: CollectionExtensionInstall): CollectionMediaMode;
    resolveMediaPreference?(
        install: CollectionExtensionInstall,
        requestedPreference?: CollectionMediaPreferenceValue,
    ): CollectionMediaPreference | null;
    resolveTokenMediaPresentation?(
        install: CollectionExtensionInstall,
        context: BackendCollectionExtensionTokenMediaContext,
    ): TokenMediaPresentation | null | Promise<TokenMediaPresentation | null>;
    resolveTokenCardArtifactRef(
        install: CollectionExtensionInstall,
        context: {
            mediaMode: CollectionMediaMode;
            mediaPreferenceEnabled: boolean;
        },
    ): string | null;
    resolveTokenArtifactRef(
        install: CollectionExtensionInstall,
        context: {
            mediaMode: CollectionMediaMode;
            mediaVariant: string | null;
        },
    ): string | null;
    resolveTokenCard(
        install: CollectionExtensionInstall,
        token: TokenCard,
        context: BackendCollectionExtensionMediaContext,
    ): TokenCard;
    resolveTokenPreview(
        install: CollectionExtensionInstall,
        token: TokenMediaPreview,
        context: BackendCollectionExtensionMediaContext,
    ): TokenMediaPreview | Promise<TokenMediaPreview>;
    resolveTokenDetail(
        install: CollectionExtensionInstall,
        token: TokenDetail,
        context: BackendCollectionExtensionMediaContext,
    ): TokenDetail | Promise<TokenDetail>;
    resolveActivityEventPreview?(
        install: CollectionExtensionInstall,
        event: BackendCollectionExtensionActivityEventContext,
        context: BackendCollectionExtensionRenderContext,
    ): Promise<TokenMediaPreview | null>;
    listActivityEventPreviewModes?(
        install: CollectionExtensionInstall,
        event: BackendCollectionExtensionActivityEventContext,
    ): CollectionMediaModeOption[];
    defaultActivityEventPreviewMode?(
        install: CollectionExtensionInstall,
        event: BackendCollectionExtensionActivityEventContext,
    ): string;
    resolveTokenUri?(
        install: CollectionExtensionInstall,
        input: {
            chainId: number;
            collectionId: number;
            contract: string;
            tokenId: string;
        },
        context: BackendCollectionExtensionTokenUriContext,
    ): Promise<string | null>;
}
