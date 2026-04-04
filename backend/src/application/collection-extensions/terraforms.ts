import {
    COLLECTION_EXTENSION_KEYS,
    COLLECTION_MEDIA_MODES,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_MEDIA_MODES,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import type { BackendCollectionExtension } from "./types.js";
import type {
    TokenCard,
    TokenDetail,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

export const terraformsBackendCollectionExtension: BackendCollectionExtension =
    {
        key: COLLECTION_EXTENSION_KEYS.Terraforms,
        resolveTraitFilterPresentationConfig() {
            return {
                rangeKeys: ["???"],
            };
        },
        resolveTokenCardTraitSummaryTemplateConfig() {
            return {
                template: "L{Level}/B{Biome}/{Zone}",
            };
        },
        resolveActivityRowTraitSummaryTemplateConfig() {
            return {
                template: "L{Level}/B{Biome}/{Zone}",
            };
        },
        listMediaModes() {
            return [
                {
                    key: COLLECTION_MEDIA_MODES.Artifact,
                    label: "artifact",
                },
                {
                    key: COLLECTION_MEDIA_MODES.Snapshot,
                    label: "snapshot",
                },
            ];
        },
        defaultMediaMode() {
            return COLLECTION_MEDIA_MODES.Artifact;
        },
        resolveTokenMediaPresentation(_install, context) {
            const availableModes = [
                {
                    key: COLLECTION_MEDIA_MODES.Artifact,
                    label: "artifact",
                },
                ...(context.getArtifact(
                    TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
                )
                    ? [
                          {
                              key: TERRAFORMS_MEDIA_MODES.LostTerrain,
                              label: "lost",
                          },
                      ]
                    : []),
                {
                    key: COLLECTION_MEDIA_MODES.Snapshot,
                    label: "snapshot",
                },
            ];
            const defaultMode = COLLECTION_MEDIA_MODES.Artifact;
            const selectedMode =
                context.requestedMode &&
                availableModes.some((mode) => mode.key === context.requestedMode)
                    ? context.requestedMode
                    : defaultMode;
            return {
                selectedMode,
                defaultMode,
                availableModes,
            };
        },
        resolveArtifactRef(_install, mediaMode) {
            if (mediaMode === COLLECTION_MEDIA_MODES.Artifact) {
                return TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media;
            }
            if (mediaMode === TERRAFORMS_MEDIA_MODES.LostTerrain) {
                return TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain;
            }
            return null;
        },
        resolveTokenCard(
            install: CollectionExtensionInstall,
            token: TokenCard,
            context,
        ): TokenCard {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                !isTerraformsArtifact(context.artifact)
            ) {
                return token;
            }

            return {
                ...token,
                image: context.artifact.image ?? token.image,
            };
        },
        resolveTokenPreview(
            install: CollectionExtensionInstall,
            token: TokenMediaPreview,
            context,
        ): TokenMediaPreview {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                !isTerraformsArtifact(context.artifact)
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
        resolveTokenDetail(
            install: CollectionExtensionInstall,
            token: TokenDetail,
            context,
        ): TokenDetail {
            if (
                install.extensionKey !== COLLECTION_EXTENSION_KEYS.Terraforms ||
                !isTerraformsArtifact(context.artifact)
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

function isTerraformsArtifact(
    artifact: {
        artifactRef: string;
        image: string | null;
        htmlContent: string | null;
    } | null,
): artifact is {
    artifactRef: string;
    image: string | null;
    htmlContent: string | null;
} {
    return (
        artifact?.artifactRef === TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media ||
        artifact?.artifactRef ===
            TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain
    );
}
