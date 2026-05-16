import {
    COLLECTION_MEDIA_MODES,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import {
    normalizeTerraformsCanvasRows,
    parseTerraformsExtensionConfig,
    resolveTerraformsCommittedCanvasStatus,
    TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS,
    TERRAFORMS_EVENT_RENDER_MODE_OPTIONS,
    TERRAFORMS_EVENT_RENDER_MODES,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX,
    TERRAFORMS_MEDIA_MODES,
    TERRAFORMS_SEED,
    TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT,
    TERRAFORMS_TRAIT_SUMMARY_TEMPLATE,
} from "@artgod/shared/extensions/terraforms";
import type {
    BackendCollectionExtension,
    BackendCollectionExtensionActivityEventContext,
    BackendCollectionExtensionRenderContext,
    BackendRpcHex,
} from "./types.js";
import type {
    TokenCard,
    TokenDetail,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";
import { concatHex, hexToBigInt, keccak256, padHex, toHex } from "viem";

const DEFAULT_DECAY = 0n;
const TERRAFORMS_ACTIVITY_EVENT_FEED_LABELS = {
    Dreams: "dreams",
    Beacon: "beacon",
} as const;

const TERRAFORMS_BEACON_ACTIVITY_FILTER_LABELS = {
    Token: "token",
    Maker: "maker",
    EventGroup: "type",
} as const;

const TERRAFORMS_MAIN_ABI = [
    {
        name: "tokenToPlacement",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "tokenToStatus",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "uint8" }],
    },
    {
        name: "tokenURI",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "string" }],
    },
    {
        name: "tokenURIAddresses",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "index" }],
        outputs: [{ type: "address" }],
    },
] as const;

const TERRAFORMS_RENDERER_ABI = [
    {
        name: "tokenURI",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "tokenId" },
            { type: "uint256", name: "status" },
            { type: "uint256", name: "placement" },
            { type: "uint256", name: "seed" },
            { type: "uint256", name: "decay" },
            { type: "uint256[]", name: "canvas" },
        ],
        outputs: [{ type: "string" }],
    },
    {
        name: "tokenHTML",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "status" },
            { type: "uint256", name: "placement" },
            { type: "uint256", name: "seed" },
            { type: "uint256", name: "decay" },
            { type: "uint256[]", name: "canvas" },
        ],
        outputs: [{ type: "string" }],
    },
] as const;

export const terraformsBackendCollectionExtension: BackendCollectionExtension =
    {
        key: TERRAFORMS_EXTENSION_KEY,
        resolveTraitFilterPresentationConfig() {
            return {
                rangeKeys: ["???"],
            };
        },
        resolveExcludedTraitFacetKeys() {
            return ["???"];
        },
        resolveTokenCardTraitSummaryTemplateConfig() {
            return {
                template: TERRAFORMS_TRAIT_SUMMARY_TEMPLATE,
            };
        },
        resolveActivityRowTraitSummaryTemplateConfig() {
            return {
                template: TERRAFORMS_TRAIT_SUMMARY_TEMPLATE,
            };
        },
        listActivityEventFeeds() {
            return [
                {
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                    eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
                    label: TERRAFORMS_ACTIVITY_EVENT_FEED_LABELS.Dreams,
                    filters: {
                        tokenId: { label: "token" },
                        maker: { label: "maker" },
                        contentHash: { label: "canvas hash" },
                    },
                },
                {
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                    eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
                    label: TERRAFORMS_ACTIVITY_EVENT_FEED_LABELS.Beacon,
                    filters: {
                        tokenId: {
                            label: TERRAFORMS_BEACON_ACTIVITY_FILTER_LABELS.Token,
                        },
                        maker: {
                            label: TERRAFORMS_BEACON_ACTIVITY_FILTER_LABELS.Maker,
                        },
                        eventGroup: {
                            label: TERRAFORMS_BEACON_ACTIVITY_FILTER_LABELS.EventGroup,
                            options: TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS.map(
                                (option) => ({ ...option }),
                            ),
                        },
                    },
                },
            ];
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
                availableModes.some(
                    (mode) => mode.key === context.requestedMode,
                )
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
                install.extensionKey !== TERRAFORMS_EXTENSION_KEY ||
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
                install.extensionKey !== TERRAFORMS_EXTENSION_KEY ||
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
                install.extensionKey !== TERRAFORMS_EXTENSION_KEY ||
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
        async resolveActivityEventPreview(install, event, context) {
            if (
                install.extensionKey !== TERRAFORMS_EXTENSION_KEY ||
                event.payload?.eventKey !==
                    TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed
            ) {
                return null;
            }

            const config = parseTerraformsExtensionConfig(install.configJson);
            const renderMode = resolveTerraformsRenderMode(context.renderMode);
            const renderArgs = await resolveTerraformedEventRenderArgs(
                event,
                config.mainContractAddress,
                context,
            );
            const rendererAddress =
                renderMode === TERRAFORMS_EVENT_RENDER_MODES.Artifact
                    ? config.rendererV2ContractAddress
                    : await resolveNetworkRendererAddress(
                          event.tokenId,
                          config.mainContractAddress,
                          context,
                      );
            const html = await context.rpc.readContract<string>({
                address: rendererAddress as BackendRpcHex,
                abi: TERRAFORMS_RENDERER_ABI,
                functionName: "tokenHTML",
                args: [
                    renderArgs.status,
                    renderArgs.placement,
                    renderArgs.seed,
                    renderArgs.decay,
                    renderArgs.canvas,
                ],
            });

            return {
                tokenId: event.tokenId,
                image: null,
                animationUrl: buildHtmlDataUrl(html),
            };
        },
        listActivityEventPreviewModes(_install, event) {
            return event.payload?.eventKey ===
                TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed
                ? listTerraformsEventRenderModes()
                : [];
        },
        defaultActivityEventPreviewMode() {
            return TERRAFORMS_EVENT_RENDER_MODES.Artifact;
        },
        async resolveTokenUri(install, input, context) {
            if (install.extensionKey !== TERRAFORMS_EXTENSION_KEY) {
                return null;
            }
            const config = parseTerraformsExtensionConfig(install.configJson);
            return context.rpc.readContract<string>({
                address: config.mainContractAddress as BackendRpcHex,
                abi: TERRAFORMS_MAIN_ABI,
                functionName: "tokenURI",
                args: [BigInt(input.tokenId)],
            });
        },
    };

export function listTerraformsEventRenderModes() {
    return TERRAFORMS_EVENT_RENDER_MODE_OPTIONS.map((mode) => ({ ...mode }));
}

function buildHtmlDataUrl(htmlContent: string | null): string | null {
    if (!htmlContent) {
        return null;
    }
    const encoded = Buffer.from(htmlContent, "utf8").toString("base64");
    return `data:text/html;base64,${encoded}`;
}

function resolveTerraformsRenderMode(
    value: string | undefined,
): (typeof TERRAFORMS_EVENT_RENDER_MODES)[keyof typeof TERRAFORMS_EVENT_RENDER_MODES] {
    return value === TERRAFORMS_EVENT_RENDER_MODES.Network
        ? TERRAFORMS_EVENT_RENDER_MODES.Network
        : TERRAFORMS_EVENT_RENDER_MODES.Artifact;
}

async function resolveTerraformedEventRenderArgs(
    event: BackendCollectionExtensionActivityEventContext,
    mainContractAddress: string,
    context: BackendCollectionExtensionRenderContext,
): Promise<{
    status: bigint;
    placement: bigint;
    seed: bigint;
    decay: bigint;
    canvas: bigint[];
}> {
    const tokenId = BigInt(event.tokenId);
    const blockNumber = event.blockNumber ?? undefined;
    // Read current status only to preserve origin lineage in renderer args.
    const [placement, tokenStatus] = await Promise.all([
        context.rpc.readContract<bigint>({
            address: mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToPlacement",
            args: [tokenId],
            blockNumber,
        }),
        context.rpc.readContract<bigint | number>({
            address: mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToStatus",
            args: [tokenId],
        }),
    ]);

    return {
        status: resolveTerraformsCommittedCanvasStatus(tokenStatus),
        placement,
        seed: TERRAFORMS_SEED,
        decay: DEFAULT_DECAY,
        canvas: readCanvasRowsFromPayload(event.payload),
    };
}

function readCanvasRowsFromPayload(
    payload: Record<string, unknown> | null,
): bigint[] {
    const raw = payload?.canvasRows;
    if (!Array.isArray(raw)) {
        throw new Error("Terraforms event payload is missing canvas rows");
    }
    const rows = raw.map((row) => {
        if (typeof row !== "string" && typeof row !== "number") {
            throw new Error("Invalid Terraforms event canvas row");
        }
        return BigInt(row);
    });
    return normalizeCanvas(rows);
}

function normalizeCanvas(rows: bigint[]): bigint[] {
    return normalizeTerraformsCanvasRows(rows);
}

async function resolveNetworkRendererAddress(
    tokenId: string,
    mainContractAddress: string,
    context: BackendCollectionExtensionRenderContext,
): Promise<string> {
    const index = await resolveTokenUriAddressIndex({
        tokenId: BigInt(tokenId),
        mainContractAddress,
        context,
    });
    const knownAddress =
        TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX[index.toString()];
    if (knownAddress) {
        return knownAddress;
    }

    const address = await context.rpc.readContract<string>({
        address: mainContractAddress as BackendRpcHex,
        abi: TERRAFORMS_MAIN_ABI,
        functionName: "tokenURIAddresses",
        args: [index],
    });
    return address.toLowerCase();
}

async function resolveTokenUriAddressIndex(params: {
    tokenId: bigint;
    mainContractAddress: string;
    context: BackendCollectionExtensionRenderContext;
}): Promise<bigint> {
    const slot = keccak256(
        concatHex([
            padHex(toHex(params.tokenId), { size: 32 }),
            padHex(toHex(TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT), {
                size: 32,
            }),
        ]),
    );
    const stored = await params.context.rpc.getStorageAt({
        address: params.mainContractAddress as BackendRpcHex,
        slot,
    });
    return stored ? hexToBigInt(stored) : 0n;
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
        artifact?.artifactRef === TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain
    );
}
