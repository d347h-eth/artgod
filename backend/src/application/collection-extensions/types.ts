import type {
    CollectionExtensionKey,
    CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type { TokenCard, TokenDetail } from "@artgod/shared/types/browse";

export type BackendCollectionExtensionArtifactRecord = {
    extensionKey: CollectionExtensionKey;
    artifactRef: string;
    image: string | null;
    animationUrl: string | null;
    htmlContent: string | null;
};

export interface BackendCollectionExtension {
    key: CollectionExtensionKey;
    resolveTokenCard(
        install: CollectionExtensionInstall,
        token: TokenCard,
        artifact: BackendCollectionExtensionArtifactRecord | null,
    ): TokenCard;
    resolveTokenDetail(
        install: CollectionExtensionInstall,
        token: TokenDetail,
        artifact: BackendCollectionExtensionArtifactRecord | null,
    ): TokenDetail;
}
