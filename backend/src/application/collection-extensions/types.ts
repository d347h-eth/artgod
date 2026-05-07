import type {
    CollectionExtensionKey,
    CollectionExtensionInstall,
    CollectionMediaMode,
    CollectionMediaPresentation,
    CollectionMediaModeOption,
} from "@artgod/shared/extensions";
import type {
    ActivityExtensionEventFeed,
    TraitFilterPresentationConfig,
    TraitSummaryTemplateConfig,
} from "@artgod/shared/types";
import type {
    TokenCard,
    TokenDetail,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

export type BackendCollectionExtensionArtifactRecord = {
    extensionKey: CollectionExtensionKey;
    artifactRef: string;
    image: string | null;
    animationUrl: string | null;
    htmlContent: string | null;
};

export type BackendCollectionExtensionMediaContext = {
    mediaMode: CollectionMediaMode;
    artifact: BackendCollectionExtensionArtifactRecord | null;
};

export type BackendCollectionExtensionTokenMediaContext = {
    requestedMode?: CollectionMediaMode;
    getArtifact(
        artifactRef: string,
    ): BackendCollectionExtensionArtifactRecord | null;
};

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
    listActivityEventFeeds(
        install: CollectionExtensionInstall,
    ): ActivityExtensionEventFeed[];
    listMediaModes(
        install: CollectionExtensionInstall,
    ): CollectionMediaModeOption[];
    defaultMediaMode(install: CollectionExtensionInstall): CollectionMediaMode;
    resolveTokenMediaPresentation?(
        install: CollectionExtensionInstall,
        context: BackendCollectionExtensionTokenMediaContext,
    ): CollectionMediaPresentation | null;
    resolveArtifactRef(
        install: CollectionExtensionInstall,
        mediaMode: CollectionMediaMode,
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
    ): TokenMediaPreview;
    resolveTokenDetail(
        install: CollectionExtensionInstall,
        token: TokenDetail,
        context: BackendCollectionExtensionMediaContext,
    ): TokenDetail;
}
