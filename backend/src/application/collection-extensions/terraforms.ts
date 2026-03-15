import {
    COLLECTION_EXTENSION_KEYS,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type { TokenCard, TokenDetail } from "@artgod/shared/types/browse";
import type {
    BackendCollectionExtension,
    BackendCollectionExtensionArtifactRecord,
} from "./types.js";

export const terraformsBackendCollectionExtension: BackendCollectionExtension =
    {
        key: COLLECTION_EXTENSION_KEYS.Terraforms,
        resolveTokenCard(
            install: CollectionExtensionInstall,
            token: TokenCard,
            artifact: BackendCollectionExtensionArtifactRecord | null,
        ): TokenCard {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                artifact?.artifactRef !==
                    TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media
            ) {
                return token;
            }

            return {
                ...token,
                image: artifact.image ?? token.image,
            };
        },
        resolveTokenDetail(
            install: CollectionExtensionInstall,
            token: TokenDetail,
            artifact: BackendCollectionExtensionArtifactRecord | null,
        ): TokenDetail {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                artifact?.artifactRef !==
                    TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media
            ) {
                return token;
            }

            return {
                ...token,
                image: artifact.image ?? token.image,
                animationUrl:
                    buildHtmlDataUrl(artifact.htmlContent) ??
                    token.animationUrl,
            };
        },
    };

function buildHtmlDataUrl(htmlContent: string | null): string | null {
    if (!htmlContent) {
        return null;
    }
    const encoded = Buffer.from(htmlContent, "utf8").toString("base64");
    return `data:text/html;base64,${encoded}`;
}
