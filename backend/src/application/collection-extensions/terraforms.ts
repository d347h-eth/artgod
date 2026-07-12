import {
    COLLECTION_MEDIA_MODE_OPTIONS,
    COLLECTION_MEDIA_MODES,
    COLLECTION_MEDIA_PREFERENCE_VALUES,
    type CollectionExtensionInstall,
    type CollectionMediaPreferenceValue,
} from "@artgod/shared/extensions";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { COLLECTION_MEDIA_SOURCE } from "@artgod/shared/types";
import {
    normalizeTerraformsCanvasRows,
    parseTerraformsExtensionConfig,
    resolveTerraformsCommittedCanvasStatus,
    TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS,
    TERRAFORMS_CANVAS_ROW_COUNT,
    TERRAFORMS_DECAY_DELAY_SECONDS_PER_DREAMER,
    TERRAFORMS_DECAY_DREAMER_THRESHOLD,
    TERRAFORMS_DECAY_PERIOD_SECONDS,
    TERRAFORMS_EVENT_RENDER_MODE_OPTIONS,
    TERRAFORMS_EVENT_RENDER_MODES,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX,
    TERRAFORMS_MAIN_READ_FUNCTIONS,
    TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED,
    TERRAFORMS_MEDIA_PREFERENCE_LABEL,
    TERRAFORMS_MEDIA_MODE_OPTIONS,
    TERRAFORMS_MEDIA_MODES,
    TERRAFORMS_MEDIA_VARIANT_BY_RENDERER_INDEX,
    TERRAFORMS_MEDIA_VARIANT_OPTIONS,
    TERRAFORMS_MEDIA_VARIANTS,
    TERRAFORMS_PLACEMENT_SEED,
    TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT,
    TERRAFORMS_RENDERER_READ_FUNCTIONS,
    TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
    TERRAFORMS_TOKEN_TO_CANVAS_DATA_STORAGE_SLOT,
    TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT,
    TERRAFORMS_TRAIT_SUMMARY_TEMPLATE,
    TERRAFORMS_VERSION_ATTRIBUTE_KEY,
    TERRAFORMS_VERSION_ATTRIBUTE_VALUES,
} from "@artgod/shared/extensions/terraforms";
import type {
    BackendCollectionExtension,
    BackendCollectionExtensionActivityEventContext,
    BackendCollectionExtensionRenderContext,
    BackendCollectionExtensionTokenMediaContext,
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
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.Dreamers,
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.RevealTimestamp,
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.Seed,
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToPlacement,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "uint256" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToStatus,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "uint8" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData,
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "tokenId" },
            { type: "uint256", name: "row" },
        ],
        outputs: [{ type: "uint256" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenUri,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "string" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenUriAddresses,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "index" }],
        outputs: [{ type: "address" }],
    },
    {
        name: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenHtml,
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "string" }],
    },
] as const;

const TERRAFORMS_RENDERER_ABI = [
    {
        name: TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenUri,
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
        name: TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml,
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
                rangeKeys: ["???", TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY],
            };
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
        resolveImageCachePolicyConfig() {
            return {
                imageCacheMode: IMAGE_CACHE_MODE.Off,
                maxDimension: null,
            };
        },
        resolveMediaPurposePolicyConfig() {
            return {
                tokenCard: COLLECTION_MEDIA_SOURCE.Image,
                fullscreenPreview: COLLECTION_MEDIA_SOURCE.AnimationUrl,
                tokenDetail: COLLECTION_MEDIA_SOURCE.AnimationUrl,
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
                { ...COLLECTION_MEDIA_MODE_OPTIONS.Snapshot },
                { ...TERRAFORMS_MEDIA_MODE_OPTIONS.Live },
            ];
        },
        defaultMediaMode() {
            return COLLECTION_MEDIA_MODES.Snapshot;
        },
        resolveMediaPreference(_install, requestedPreference) {
            return resolveTerraformsMediaPreference(requestedPreference);
        },
        async resolveTokenMediaPresentation(install, context) {
            return resolveTerraformsTokenMediaPresentation(install, context);
        },
        resolveTokenCardArtifactRef(_install, context) {
            if (
                context.mediaMode === COLLECTION_MEDIA_MODES.Snapshot &&
                context.mediaPreferenceEnabled
            ) {
                return TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media;
            }
            return null;
        },
        resolveTokenArtifactRef(_install, context) {
            if (
                context.mediaMode === COLLECTION_MEDIA_MODES.Snapshot &&
                context.mediaVariant === TERRAFORMS_MEDIA_VARIANTS.V2Artifact
            ) {
                return TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media;
            }
            if (
                context.mediaMode === COLLECTION_MEDIA_MODES.Snapshot &&
                context.mediaVariant === TERRAFORMS_MEDIA_VARIANTS.V2LostTerrain
            ) {
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
        async resolveTokenPreview(
            install: CollectionExtensionInstall,
            token: TokenMediaPreview,
            context,
        ): Promise<TokenMediaPreview> {
            if (context.mediaMode === TERRAFORMS_MEDIA_MODES.Live) {
                return {
                    ...token,
                    animationUrl: buildHtmlDataUrl(
                        await resolveLiveTokenHtml(
                            install,
                            token.tokenId,
                            context.mediaVariant,
                            context,
                        ),
                    ),
                };
            }

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
        async resolveTokenDetail(
            install: CollectionExtensionInstall,
            token: TokenDetail,
            context,
        ): Promise<TokenDetail> {
            if (context.mediaMode === TERRAFORMS_MEDIA_MODES.Live) {
                return {
                    ...token,
                    animationUrl: buildHtmlDataUrl(
                        await resolveLiveTokenHtml(
                            install,
                            token.tokenId,
                            context.mediaVariant,
                            context,
                        ),
                    ),
                };
            }

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
                functionName: TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml,
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
                functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenUri,
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

async function resolveLiveTokenHtml(
    install: CollectionExtensionInstall,
    tokenId: string,
    requestedVariant: string | null,
    context: { rpc?: BackendCollectionExtensionRenderContext["rpc"] },
): Promise<string> {
    if (!context.rpc) {
        throw new Error("Terraforms live media requires backend RPC context");
    }
    const config = parseTerraformsExtensionConfig(install.configJson);
    const numericTokenId = BigInt(tokenId);
    const mediaVariant = isLiveTerraformsMediaVariant(requestedVariant)
        ? requestedVariant
        : TERRAFORMS_MEDIA_VARIANTS.V2;
    const blockNumber = await context.rpc.getCurrentBlockNumber();
    const renderContext = { rpc: context.rpc };
    const currentRendererIndex = await resolveTokenUriAddressIndex({
        tokenId: numericTokenId,
        mainContractAddress: config.mainContractAddress,
        context: renderContext,
        blockNumber,
    });
    const currentVariant =
        TERRAFORMS_MEDIA_VARIANT_BY_RENDERER_INDEX[
            currentRendererIndex.toString()
        ];

    if (currentVariant === mediaVariant) {
        // Let the main contract render an exact current-version match at the pinned block.
        return context.rpc.readContract<string>({
            address: config.mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenHtml,
            args: [numericTokenId],
            blockNumber,
        });
    }

    // Read the raw token fields used by every explicit renderer at the pinned block.
    const [placement, rawStatus, seed] = await Promise.all([
        context.rpc.readContract<bigint>({
            address: config.mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToPlacement,
            args: [numericTokenId],
            blockNumber,
        }),
        context.rpc.readContract<bigint | number>({
            address: config.mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToStatus,
            args: [numericTokenId],
            blockNumber,
        }),
        context.rpc.readContract<bigint>({
            address: config.mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.Seed,
            blockNumber,
        }),
    ]);
    const status = BigInt(rawStatus);
    const [canvas, decay] = await Promise.all([
        readLiveCanvas({
            tokenId: numericTokenId,
            mainContractAddress: config.mainContractAddress,
            context: renderContext,
            blockNumber,
        }),
        resolveLiveDecay({
            mediaVariant,
            mainContractAddress: config.mainContractAddress,
            context: renderContext,
            blockNumber,
        }),
    ]);
    const rendererIndex =
        TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[mediaVariant];
    const rendererAddress =
        TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX[rendererIndex.toString()];
    if (!rendererAddress) {
        throw new Error(
            `Unsupported Terraforms live media variant: ${mediaVariant}`,
        );
    }

    // Call the selected TerraformsData proxy with raw state from the same block.
    return context.rpc.readContract<string>({
        address: rendererAddress as BackendRpcHex,
        abi: TERRAFORMS_RENDERER_ABI,
        functionName: TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml,
        args: [status, placement, seed, decay, canvas],
        blockNumber,
    });
}

function resolveTerraformsMediaPreference(
    requestedPreference?: CollectionMediaPreferenceValue,
) {
    const enabled =
        requestedPreference === COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled
            ? true
            : requestedPreference ===
                COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
              ? false
              : TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED;
    return {
        label: TERRAFORMS_MEDIA_PREFERENCE_LABEL,
        enabled,
        defaultEnabled: TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED,
    };
}

async function resolveTerraformsTokenMediaPresentation(
    install: CollectionExtensionInstall,
    context: BackendCollectionExtensionTokenMediaContext,
) {
    const preference = resolveTerraformsMediaPreference(
        context.requestedPreference,
    );
    const isLiveToken =
        context.canonical.isCanonicalToken && isNumericTokenId(context.tokenId);
    const availableModes = [
        { ...COLLECTION_MEDIA_MODE_OPTIONS.Snapshot },
        ...(isLiveToken ? [{ ...TERRAFORMS_MEDIA_MODE_OPTIONS.Live }] : []),
    ];
    const selectedMode =
        context.requestedMode === TERRAFORMS_MEDIA_MODES.Live && isLiveToken
            ? TERRAFORMS_MEDIA_MODES.Live
            : COLLECTION_MEDIA_MODES.Snapshot;
    const availableVariants =
        selectedMode === TERRAFORMS_MEDIA_MODES.Live
            ? listLiveTerraformsMediaVariants()
            : listSnapshotTerraformsMediaVariants(context);
    const defaultVariant =
        selectedMode === TERRAFORMS_MEDIA_MODES.Live
            ? await resolveDefaultLiveTerraformsMediaVariant(
                  install,
                  context,
                  preference.enabled,
              )
            : resolveDefaultSnapshotTerraformsMediaVariant(
                  availableVariants.map((variant) => variant.key),
                  preference.enabled,
                  context.canonical.isCanonicalToken,
              );
    const selectedVariant = availableVariants.some(
        (variant) => variant.key === context.requestedVariant,
    )
        ? (context.requestedVariant ?? defaultVariant)
        : defaultVariant;

    return {
        selectedMode,
        defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
        availableModes,
        preference,
        selectedVariant,
        defaultVariant,
        availableVariants,
    };
}

function listSnapshotTerraformsMediaVariants(
    context: BackendCollectionExtensionTokenMediaContext,
) {
    const hasCanonicalAnimation = Boolean(
        context.canonical.isCanonicalToken &&
        context.canonical.animationUrl?.trim(),
    );
    const isCanonicalV2 =
        hasCanonicalAnimation &&
        context.canonical.getAttributeValue(
            TERRAFORMS_VERSION_ATTRIBUTE_KEY,
        ) === TERRAFORMS_VERSION_ATTRIBUTE_VALUES.V2;
    const hasLostTerrainArtifact =
        context.canonical.isCanonicalToken &&
        Boolean(
            context.getArtifact(TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain),
        );

    return [
        ...(context.getArtifact(TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media)
            ? [{ ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2Artifact }]
            : []),
        ...(hasLostTerrainArtifact
            ? [{ ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2LostTerrain }]
            : []),
        ...(isCanonicalV2 ? [{ ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2 }] : []),
        ...(hasCanonicalAnimation && !isCanonicalV2
            ? [{ ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0 }]
            : []),
    ];
}

function listLiveTerraformsMediaVariants() {
    return [
        { ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2 },
        { ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V1 },
        { ...TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0 },
    ];
}

function resolveDefaultSnapshotTerraformsMediaVariant(
    availableVariants: string[],
    preferV2: boolean,
    isCanonicalToken: boolean,
): string | null {
    const preferred = preferV2
        ? [
              TERRAFORMS_MEDIA_VARIANTS.V2Artifact,
              TERRAFORMS_MEDIA_VARIANTS.V2,
              TERRAFORMS_MEDIA_VARIANTS.V0,
          ]
        : isCanonicalToken
          ? [TERRAFORMS_MEDIA_VARIANTS.V2, TERRAFORMS_MEDIA_VARIANTS.V0]
          : [TERRAFORMS_MEDIA_VARIANTS.V2Artifact];
    return (
        preferred.find((variant) => availableVariants.includes(variant)) ?? null
    );
}

async function resolveDefaultLiveTerraformsMediaVariant(
    install: CollectionExtensionInstall,
    context: BackendCollectionExtensionTokenMediaContext,
    preferV2: boolean,
): Promise<string> {
    if (preferV2) {
        return TERRAFORMS_MEDIA_VARIANTS.V2;
    }
    if (!context.rpc) {
        throw new Error("Terraforms live media requires backend RPC context");
    }
    const config = parseTerraformsExtensionConfig(install.configJson);
    const blockNumber = await context.rpc.getCurrentBlockNumber();
    const rendererIndex = await resolveTokenUriAddressIndex({
        tokenId: BigInt(context.tokenId),
        mainContractAddress: config.mainContractAddress,
        context: { rpc: context.rpc },
        blockNumber,
    });
    return (
        TERRAFORMS_MEDIA_VARIANT_BY_RENDERER_INDEX[rendererIndex.toString()] ??
        TERRAFORMS_MEDIA_VARIANTS.V0
    );
}

function isNumericTokenId(tokenId: string): boolean {
    try {
        BigInt(tokenId);
        return true;
    } catch {
        return false;
    }
}

function isLiveTerraformsMediaVariant(value: string | null): value is string {
    return (
        value === TERRAFORMS_MEDIA_VARIANTS.V2 ||
        value === TERRAFORMS_MEDIA_VARIANTS.V1 ||
        value === TERRAFORMS_MEDIA_VARIANTS.V0
    );
}

async function readLiveCanvas(params: {
    tokenId: bigint;
    mainContractAddress: string;
    context: BackendCollectionExtensionRenderContext;
    blockNumber: number;
}): Promise<bigint[]> {
    const lengthSlot = resolveTerraformsTokenMappingSlot(
        params.tokenId,
        TERRAFORMS_TOKEN_TO_CANVAS_DATA_STORAGE_SLOT,
    );
    const storedLength = await params.context.rpc.getStorageAt({
        address: params.mainContractAddress as BackendRpcHex,
        slot: lengthSlot,
        blockNumber: params.blockNumber,
    });
    if (!storedLength) {
        throw new Error("Terraforms canvas length is unavailable");
    }
    const rowCount = hexToBigInt(storedLength);
    if (rowCount === 0n) {
        return [];
    }
    if (rowCount !== BigInt(TERRAFORMS_CANVAS_ROW_COUNT)) {
        throw new Error(
            `Unexpected Terraforms canvas row count: ${rowCount}; expected ${TERRAFORMS_CANVAS_ROW_COUNT}`,
        );
    }

    // Read every retained row because Daydream tokens can preserve prior canvases.
    const rows = await Promise.all(
        Array.from({ length: TERRAFORMS_CANVAS_ROW_COUNT }, (_, row) =>
            params.context.rpc.readContract<bigint>({
                address: params.mainContractAddress as BackendRpcHex,
                abi: TERRAFORMS_MAIN_ABI,
                functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData,
                args: [params.tokenId, BigInt(row)],
                blockNumber: params.blockNumber,
            }),
        ),
    );
    return normalizeTerraformsCanvasRows(rows);
}

async function resolveLiveDecay(params: {
    mediaVariant: string;
    mainContractAddress: string;
    context: BackendCollectionExtensionRenderContext;
    blockNumber: number;
}): Promise<bigint> {
    if (params.mediaVariant !== TERRAFORMS_MEDIA_VARIANTS.V0) {
        return DEFAULT_DECAY;
    }

    const [dreamers, revealTimestamp, blockTimestamp] = await Promise.all([
        params.context.rpc.readContract<bigint>({
            address: params.mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.Dreamers,
            blockNumber: params.blockNumber,
        }),
        params.context.rpc.readContract<bigint>({
            address: params.mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.RevealTimestamp,
            blockNumber: params.blockNumber,
        }),
        params.context.rpc.getBlockTimestamp(params.blockNumber),
    ]);
    if (dreamers >= TERRAFORMS_DECAY_DREAMER_THRESHOLD) {
        return DEFAULT_DECAY;
    }
    const decayBegins =
        revealTimestamp + dreamers * TERRAFORMS_DECAY_DELAY_SECONDS_PER_DREAMER;
    const currentTimestamp = BigInt(blockTimestamp);
    if (currentTimestamp <= decayBegins) {
        return DEFAULT_DECAY;
    }
    return (currentTimestamp - decayBegins) / TERRAFORMS_DECAY_PERIOD_SECONDS;
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
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToPlacement,
            args: [tokenId],
            blockNumber,
        }),
        context.rpc.readContract<bigint | number>({
            address: mainContractAddress as BackendRpcHex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToStatus,
            args: [tokenId],
            blockNumber,
        }),
    ]);

    return {
        status: resolveTerraformsCommittedCanvasStatus(tokenStatus),
        placement,
        seed: TERRAFORMS_PLACEMENT_SEED,
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
        functionName: TERRAFORMS_MAIN_READ_FUNCTIONS.TokenUriAddresses,
        args: [index],
    });
    return address.toLowerCase();
}

async function resolveTokenUriAddressIndex(params: {
    tokenId: bigint;
    mainContractAddress: string;
    context: BackendCollectionExtensionRenderContext;
    blockNumber?: number;
}): Promise<bigint> {
    const slot = resolveTerraformsTokenMappingSlot(
        params.tokenId,
        TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT,
    );
    const stored = await params.context.rpc.getStorageAt({
        address: params.mainContractAddress as BackendRpcHex,
        slot,
        blockNumber: params.blockNumber,
    });
    return stored ? hexToBigInt(stored) : 0n;
}

function resolveTerraformsTokenMappingSlot(
    tokenId: bigint,
    mappingStorageSlot: bigint,
): BackendRpcHex {
    return keccak256(
        concatHex([
            padHex(toHex(tokenId), { size: 32 }),
            padHex(toHex(mappingStorageSlot), { size: 32 }),
        ]),
    );
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
