import {
    COLLECTION_EXTENSION_KEYS,
    COLLECTION_MEDIA_MODES,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type { TokenCard, TokenDetail } from "@artgod/shared/types/browse";
import type {
    BackendCollectionExtension,
} from "./types.js";

export const terraformsBackendCollectionExtension: BackendCollectionExtension =
    {
        key: COLLECTION_EXTENSION_KEYS.Terraforms,
        listMediaModes() {
            return [
                {
                    key: COLLECTION_MEDIA_MODES.Artifact,
                    label: "artifact",
                },
                {
                    key: COLLECTION_MEDIA_MODES.Truth,
                    label: "truth",
                },
            ];
        },
        defaultMediaMode() {
            return COLLECTION_MEDIA_MODES.Artifact;
        },
        resolveArtifactRef(_install, mediaMode) {
            if (mediaMode !== COLLECTION_MEDIA_MODES.Artifact) {
                return null;
            }
            return TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media;
        },
        resolveTokenCard(
            install: CollectionExtensionInstall,
            token: TokenCard,
            context,
        ): TokenCard {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                context.mediaMode !== COLLECTION_MEDIA_MODES.Artifact ||
                context.artifact?.artifactRef !==
                    TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media
            ) {
                return token;
            }

            return {
                ...token,
                image: context.artifact.image ?? token.image,
            };
        },
        resolveTokenDetail(
            install: CollectionExtensionInstall,
            token: TokenDetail,
            context,
        ): TokenDetail {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                context.mediaMode !== COLLECTION_MEDIA_MODES.Artifact ||
                context.artifact?.artifactRef !==
                    TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media
            ) {
                return token;
            }

            return {
                ...token,
                image: context.artifact.image ?? token.image,
                animationUrl:
                    buildHtmlDataUrl(context.artifact.htmlContent) ??
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
