import {
    hashTerraformsCanvasRows,
    normalizeTerraformsCanvasRows,
    parseTerraformsExtensionConfig,
    parseTerraformsUnmintedTokenId,
    resolveTerraformsCommittedCanvasStatus,
    TERRAFORMS_BEACON_ANTENNA_MODIFICATION_LABELS,
    TERRAFORMS_BEACON_EVENT_GROUPS,
    TERRAFORMS_BEACON_EVENT_TYPE_LABELS,
    TERRAFORMS_BEACON_EVENT_TYPES,
    TERRAFORMS_BEACON_SCRIPT_COMPONENT_LABELS,
    TERRAFORMS_CANVAS_ROW_COUNT,
    TERRAFORMS_EVENT_RENDER_MODE_OPTIONS,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_EXTENSION_EVENT_MEDIA_REFS,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_MINTED_ATTRIBUTE_KEY,
    TERRAFORMS_MINTED_ATTRIBUTE_VALUES,
    TERRAFORMS_MODE_ATTRIBUTE_KEY,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES,
    TERRAFORMS_PLACEMENT_SEED,
    TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
    TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
    buildTerraformsUnmintedTokenId,
    resolveTerraformsRendererSeedTraits,
    resolveTerraformsUnmintedPlacements,
} from "@artgod/shared/extensions/terraforms";
import type { CollectionExtensionInstall } from "@artgod/shared/extensions";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { logger } from "@artgod/shared/utils";
import { decodeEventLog, encodeEventTopics } from "viem";
import type {
    CollectionExtensionEvent,
    CollectionExtensionEventMedia,
    MetadataRefreshEvent,
    MetadataRefreshRangeEvent,
} from "../../domain/onchain.js";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import type { TokenMetadata } from "../../domain/metadata.js";
import type {
    CollectionExtensionArtifactRefreshContext,
    CollectionExtensionBootstrapArtifactSeedContext,
    CollectionExtensionBootstrapArtifactSeedResult,
    CollectionExtensionSyncDecodeResult,
    CollectionExtensionSyncWatchSpec,
    IndexerCollectionExtension,
} from "./types.js";
import type { CollectionExtensionTokenAttributeInput } from "../../ports/collection-extensions.js";
import type { Hex, RpcLog, RpcProviderPort } from "../../ports/rpc.js";

const DEFAULT_DECAY = 0n;
const TERRAFORMS_PLACEMENT_READ_BATCH_SIZE = 50;
const TERRAFORMS_COLLECTION_EXTENSION_LOG_COMPONENT = "CollectionExtensions";
const TERRAFORMS_COLLECTION_EXTENSION_LOG_ACTION = {
    SeedBootstrapArtifactTasks: "terraforms.seedBootstrapArtifactTasks",
    RefreshArtifacts: "terraforms.refreshArtifacts",
    RefreshUnmintedArtifacts: "terraforms.refreshUnmintedArtifacts",
} as const;

const TERRAFORMS_MAIN_ABI = [
    {
        name: "totalSupply",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "tokenToPlacement",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "uint256", name: "tokenId" }],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "tokenToCanvasData",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "tokenId" },
            { type: "uint256", name: "row" },
        ],
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
        name: "Daydreaming",
        type: "event",
        anonymous: false,
        inputs: [{ indexed: false, name: "tokenId", type: "uint256" }],
    },
    {
        name: "Terraformed",
        type: "event",
        anonymous: false,
        inputs: [
            { indexed: false, name: "tokenId", type: "uint256" },
            { indexed: false, name: "terraformer", type: "address" },
        ],
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
    {
        name: "tokenSVG",
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
    {
        name: "tokenHeightmapIndices",
        type: "function",
        stateMutability: "view",
        inputs: [
            { type: "uint256", name: "status" },
            { type: "uint256", name: "placement" },
            { type: "uint256", name: "seed" },
            { type: "uint256", name: "decay" },
            { type: "uint256[]", name: "canvas" },
        ],
        outputs: [{ type: "uint256[32][32]" }],
    },
] as const;

const TERRAFORMS_TOKEN_URI_V2_ABI = [
    {
        name: "AttunementSet",
        type: "event",
        anonymous: false,
        inputs: [
            { indexed: true, name: "tokenId", type: "uint256" },
            { indexed: false, name: "attunement", type: "int256" },
        ],
    },
] as const;

const TERRAFORMS_BEACON_V2_ABI = [
    {
        name: "ParcelModified",
        type: "event",
        anonymous: false,
        inputs: [
            { indexed: false, name: "tokenId", type: "uint256" },
            { indexed: false, name: "modification", type: "uint8" },
        ],
    },
    {
        name: "BroadcastAdded",
        type: "event",
        anonymous: false,
        inputs: [
            { indexed: false, name: "satellite", type: "address" },
            { indexed: false, name: "duration", type: "uint256" },
        ],
    },
    {
        name: "BroadcastRemoved",
        type: "event",
        anonymous: false,
        inputs: [{ indexed: false, name: "satellite", type: "address" }],
    },
    {
        name: "BroadcastModified",
        type: "event",
        anonymous: false,
        inputs: [
            { indexed: false, name: "satellite", type: "address" },
            { indexed: false, name: "duration", type: "uint256" },
        ],
    },
    {
        name: "BroadcastOrderModified",
        type: "event",
        anonymous: false,
        inputs: [{ indexed: false, name: "order", type: "uint256[]" }],
    },
    {
        name: "ScriptComponentModified",
        type: "event",
        anonymous: false,
        inputs: [
            { indexed: false, name: "componentType", type: "uint8" },
            { indexed: false, name: "index", type: "uint256" },
        ],
    },
] as const;

const [DAYDREAMING_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_MAIN_ABI,
    eventName: "Daydreaming",
}) as [Hex];
const [TERRAFORMED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_MAIN_ABI,
    eventName: "Terraformed",
}) as [Hex];
const [ATTUNEMENT_SET_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_TOKEN_URI_V2_ABI,
    eventName: "AttunementSet",
}) as [Hex];
const [PARCEL_MODIFIED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_BEACON_V2_ABI,
    eventName: "ParcelModified",
}) as [Hex];
const [BROADCAST_ADDED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_BEACON_V2_ABI,
    eventName: "BroadcastAdded",
}) as [Hex];
const [BROADCAST_REMOVED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_BEACON_V2_ABI,
    eventName: "BroadcastRemoved",
}) as [Hex];
const [BROADCAST_MODIFIED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_BEACON_V2_ABI,
    eventName: "BroadcastModified",
}) as [Hex];
const [BROADCAST_ORDER_MODIFIED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_BEACON_V2_ABI,
    eventName: "BroadcastOrderModified",
}) as [Hex];
const [SCRIPT_COMPONENT_MODIFIED_TOPIC] = encodeEventTopics({
    abi: TERRAFORMS_BEACON_V2_ABI,
    eventName: "ScriptComponentModified",
}) as [Hex];

const BEACON_EVENT_TOPICS = new Set<Hex>([
    PARCEL_MODIFIED_TOPIC,
    BROADCAST_ADDED_TOPIC,
    BROADCAST_REMOVED_TOPIC,
    BROADCAST_MODIFIED_TOPIC,
    BROADCAST_ORDER_MODIFIED_TOPIC,
    SCRIPT_COMPONENT_MODIFIED_TOPIC,
]);

const TERRAFORMS_STATUS_SLUG = {
    Terrain: "terrain",
    Daydream: "daydream",
    Terraform: "terraform",
    OriginDaydream: "origin-daydream",
    OriginTerraform: "origin-terraform",
} as const;

type TerraformsStatusSlug =
    (typeof TERRAFORMS_STATUS_SLUG)[keyof typeof TERRAFORMS_STATUS_SLUG];

type TerraformsStatus = {
    slug: TerraformsStatusSlug;
    value: bigint;
};

const MODE_TO_STATUS: Record<string, TerraformsStatus> = {
    [TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain]: {
        slug: TERRAFORMS_STATUS_SLUG.Terrain,
        value: 0n,
    },
    [TERRAFORMS_MODE_ATTRIBUTE_VALUES.Daydream]: {
        slug: TERRAFORMS_STATUS_SLUG.Daydream,
        value: 1n,
    },
    [TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terraform]: {
        slug: TERRAFORMS_STATUS_SLUG.Terraform,
        value: 2n,
    },
    [TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginDaydream]: {
        slug: TERRAFORMS_STATUS_SLUG.OriginDaydream,
        value: 3n,
    },
    [TERRAFORMS_MODE_ATTRIBUTE_VALUES.OriginTerraform]: {
        slug: TERRAFORMS_STATUS_SLUG.OriginTerraform,
        value: 4n,
    },
};

export const terraformsIndexerExtension: IndexerCollectionExtension = {
    key: TERRAFORMS_EXTENSION_KEY,
    resolveImageCachePolicyConfig() {
        return {
            imageCacheMode: IMAGE_CACHE_MODE.Off,
            maxDimension: null,
        };
    },
    buildSyncWatchSpecs(install: CollectionExtensionInstall) {
        const config = parseTerraformsExtensionConfig(install.configJson);
        return [
            {
                collectionId: install.collectionId,
                sourceId: "terraforms-main",
                address: config.mainContractAddress as Hex,
                events: [
                    TERRAFORMS_MAIN_ABI[5],
                    TERRAFORMS_MAIN_ABI[4],
                ] as const,
                decode: (log, context) =>
                    decodeTokenRefreshLog(
                        log,
                        install.collectionId,
                        config,
                        context.rpc,
                    ),
            },
            {
                collectionId: install.collectionId,
                sourceId: "terraforms-token-uri-v2",
                address: config.tokenUriV2ContractAddress as Hex,
                events: [TERRAFORMS_TOKEN_URI_V2_ABI[0]] as const,
                decode: (log, context) =>
                    decodeTokenRefreshLog(
                        log,
                        install.collectionId,
                        config,
                        context.rpc,
                    ),
            },
            {
                collectionId: install.collectionId,
                sourceId: "terraforms-beacon-v2",
                address: config.beaconV2ContractAddress as Hex,
                events: TERRAFORMS_BEACON_V2_ABI,
                decode: (log, context) =>
                    decodeTokenRefreshLog(
                        log,
                        install.collectionId,
                        config,
                        context.rpc,
                    ),
            },
        ];
    },
    async seedBootstrapArtifactTasks(
        context: CollectionExtensionBootstrapArtifactSeedContext,
    ): Promise<CollectionExtensionBootstrapArtifactSeedResult> {
        const config = parseTerraformsExtensionConfig(
            context.install.configJson,
        );
        const mintedPlacements = await readMintedPlacements(
            context.rpc,
            config.mainContractAddress,
        );
        const unmintedPlacements =
            resolveTerraformsUnmintedPlacements(mintedPlacements);
        const tasksSeeded =
            context.tasks.insertCollectionExtensionArtifactTasks(
                unmintedPlacements.map((placement) => ({
                    runId: context.run.runId,
                    chainId: context.run.chainId,
                    collectionId: context.run.collectionId,
                    contract: config.mainContractAddress,
                    tokenId: buildTerraformsUnmintedTokenId(placement),
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                })),
            );
        logger.info("Terraforms unminted artifact tasks seeded", {
            component: TERRAFORMS_COLLECTION_EXTENSION_LOG_COMPONENT,
            action: TERRAFORMS_COLLECTION_EXTENSION_LOG_ACTION.SeedBootstrapArtifactTasks,
            chainId: context.run.chainId,
            collectionId: context.run.collectionId,
            minted: mintedPlacements.length,
            unminted: unmintedPlacements.length,
            tasksSeeded,
        });
        return { tasksSeeded };
    },
    async refreshArtifacts(context: CollectionExtensionArtifactRefreshContext) {
        const config = parseTerraformsExtensionConfig(
            context.install.configJson,
        );
        const tokenId = context.payload.tokenId;
        const contract = context.payload.contract.toLowerCase();
        const syntheticPlacement = parseTerraformsUnmintedTokenId(tokenId);
        if (syntheticPlacement !== null) {
            return refreshUnmintedPlacementArtifacts(context, {
                rendererV2ContractAddress: config.rendererV2ContractAddress,
                contract,
                tokenId,
                placement: syntheticPlacement,
            });
        }

        const tokenMode = context.artifacts.getTokenAttributeValue({
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            tokenId,
            key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
        });
        if (!tokenMode) {
            throw new Error(
                `Terraforms mode attribute missing for token ${contract}:${tokenId}`,
            );
        }

        const status = resolveStatusFromMode(tokenMode);
        const placement = await context.rpc.readContract<bigint>({
            address: config.mainContractAddress as Hex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToPlacement",
            args: [BigInt(tokenId)],
        });

        retireUnmintedPlacementToken(context, {
            contract,
            placement,
        });

        const currentRenderArgs = await resolveRendererArgs(context, {
            mainContractAddress: config.mainContractAddress,
            rendererV2ContractAddress: config.rendererV2ContractAddress,
            tokenId: BigInt(tokenId),
            placement,
            seed: TERRAFORMS_PLACEMENT_SEED,
            status,
        });
        await upsertRenderedArtifact(context, {
            rendererV2ContractAddress: config.rendererV2ContractAddress,
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            contract,
            tokenId,
            rendererTokenId: BigInt(tokenId),
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            renderArgs: currentRenderArgs,
            metadataFetchFailureMessage: `Terraforms v2 metadata fetch failed for token ${contract}:${tokenId}`,
            htmlFetchFailureMessage: `Terraforms v2 HTML fetch failed for token ${contract}:${tokenId}`,
        });

        let lostTerrainWritten = false;
        if (status.slug !== TERRAFORMS_STATUS_SLUG.Terrain) {
            await upsertRenderedArtifact(context, {
                rendererV2ContractAddress: config.rendererV2ContractAddress,
                chainId: context.payload.chainId,
                collectionId: context.payload.collectionId,
                contract,
                tokenId,
                rendererTokenId: BigInt(tokenId),
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
                renderArgs: resolveTerrainRendererArgs({
                    placement,
                    seed: TERRAFORMS_PLACEMENT_SEED,
                }),
                metadataFetchFailureMessage: `Terraforms lost terrain metadata fetch failed for token ${contract}:${tokenId}`,
                htmlFetchFailureMessage: `Terraforms lost terrain HTML fetch failed for token ${contract}:${tokenId}`,
            });
            lostTerrainWritten = true;
        }

        const seedTraits = resolveTerraformsRendererSeedTraits({
            mode: tokenMode,
            placement,
            placementSeed: TERRAFORMS_PLACEMENT_SEED,
        });
        context.attributes.replaceTokenAttributes({
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            contractAddress: contract,
            tokenId,
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            attributes: [
                {
                    key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
                    value: TERRAFORMS_MINTED_ATTRIBUTE_VALUES.True,
                },
                {
                    key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
                    value: seedTraits.seed.toString(),
                },
                ...(seedTraits.seedClass
                    ? [
                          {
                              key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
                              value: seedTraits.seedClass,
                          },
                      ]
                    : []),
            ],
        });

        logger.debug("Terraforms extension artifacts refreshed", {
            component: TERRAFORMS_COLLECTION_EXTENSION_LOG_COMPONENT,
            action: TERRAFORMS_COLLECTION_EXTENSION_LOG_ACTION.RefreshArtifacts,
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            contract,
            tokenId,
            reason: context.payload.reason,
            mode: tokenMode,
            status: currentRenderArgs.status.toString(),
            lostTerrainWritten,
        });
        return { attributesChanged: true };
    },
};

async function readMintedPlacements(
    rpc: RpcProviderPort,
    mainContractAddress: string,
): Promise<bigint[]> {
    const mintedCount = await rpc.readContract<bigint>({
        address: mainContractAddress as Hex,
        abi: TERRAFORMS_MAIN_ABI,
        functionName: "totalSupply",
        args: [],
    });
    const placements: bigint[] = [];
    for (let start = 1n; start <= mintedCount; ) {
        const batchTokenIds: bigint[] = [];
        for (
            let tokenId = start;
            tokenId <= mintedCount &&
            batchTokenIds.length < TERRAFORMS_PLACEMENT_READ_BATCH_SIZE;
            tokenId += 1n
        ) {
            batchTokenIds.push(tokenId);
        }
        const batchPlacements = await Promise.all(
            batchTokenIds.map((tokenId) =>
                rpc.readContract<bigint>({
                    address: mainContractAddress as Hex,
                    abi: TERRAFORMS_MAIN_ABI,
                    functionName: "tokenToPlacement",
                    args: [tokenId],
                }),
            ),
        );
        placements.push(...batchPlacements);
        start += BigInt(batchTokenIds.length);
    }
    return placements;
}

async function refreshUnmintedPlacementArtifacts(
    context: CollectionExtensionArtifactRefreshContext,
    params: {
        rendererV2ContractAddress: string;
        contract: string;
        tokenId: string;
        placement: bigint;
    },
): Promise<{ attributesChanged: boolean }> {
    context.syntheticTokens.upsertSyntheticToken({
        chainId: context.payload.chainId,
        collectionId: context.payload.collectionId,
        contractAddress: params.contract,
        tokenId: params.tokenId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
    });

    const metadata = await upsertRenderedArtifact(context, {
        rendererV2ContractAddress: params.rendererV2ContractAddress,
        chainId: context.payload.chainId,
        collectionId: context.payload.collectionId,
        contract: params.contract,
        tokenId: params.tokenId,
        rendererTokenId: params.placement,
        artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
        renderArgs: resolveTerrainRendererArgs({
            placement: params.placement,
            seed: TERRAFORMS_PLACEMENT_SEED,
        }),
        metadataFetchFailureMessage: `Terraforms unminted metadata fetch failed for token ${params.contract}:${params.tokenId}`,
        htmlFetchFailureMessage: `Terraforms unminted HTML fetch failed for token ${params.contract}:${params.tokenId}`,
    });

    const seedTraits = resolveTerraformsRendererSeedTraits({
        mode: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
        placement: params.placement,
        placementSeed: TERRAFORMS_PLACEMENT_SEED,
    });
    context.attributes.replaceTokenAttributes({
        chainId: context.payload.chainId,
        collectionId: context.payload.collectionId,
        contractAddress: params.contract,
        tokenId: params.tokenId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        attributes: buildTerraformsUnmintedTokenAttributes({
            metadata,
            seed: seedTraits.seed,
            seedClass: seedTraits.seedClass,
        }),
    });

    logger.debug("Terraforms unminted artifacts refreshed", {
        component: TERRAFORMS_COLLECTION_EXTENSION_LOG_COMPONENT,
        action: TERRAFORMS_COLLECTION_EXTENSION_LOG_ACTION.RefreshUnmintedArtifacts,
        chainId: context.payload.chainId,
        collectionId: context.payload.collectionId,
        contract: params.contract,
        tokenId: params.tokenId,
        placement: params.placement.toString(),
        reason: context.payload.reason,
    });
    return { attributesChanged: true };
}

// Builds extension-owned traits for synthetic unminted Terraforms rows.
export function buildTerraformsUnmintedTokenAttributes(input: {
    metadata: TokenMetadata;
    seed: bigint;
    seedClass: string | null;
}): CollectionExtensionTokenAttributeInput[] {
    const rendererAttributes = normalizeUniqueAttributeList(
        input.metadata.attributes.map((attribute) => ({
            key: attribute.traitType,
            value: attribute.value,
        })),
    ).filter(
        (attribute) =>
            attribute.key !== TERRAFORMS_MODE_ATTRIBUTE_KEY &&
            attribute.key !== TERRAFORMS_MINTED_ATTRIBUTE_KEY &&
            attribute.key !== TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY &&
            attribute.key !== TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
    );

    return [
        {
            key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            value: TERRAFORMS_MINTED_ATTRIBUTE_VALUES.False,
        },
        {
            key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
            value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
        },
        ...rendererAttributes,
        {
            key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
            value: input.seed.toString(),
        },
        ...(input.seedClass
            ? [
                  {
                      key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
                      value: input.seedClass,
                  },
              ]
            : []),
    ];
}

function retireUnmintedPlacementToken(
    context: CollectionExtensionArtifactRefreshContext,
    params: {
        contract: string;
        placement: bigint;
    },
): void {
    const syntheticTokenId = buildTerraformsUnmintedTokenId(params.placement);
    const result = context.syntheticTokens.retireSyntheticToken({
        chainId: context.payload.chainId,
        collectionId: context.payload.collectionId,
        contractAddress: params.contract,
        tokenId: syntheticTokenId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
    });
    if (result.blockedByCanonicalState) {
        throw new Error(
            `Terraforms synthetic token retirement blocked for ${syntheticTokenId}`,
        );
    }
}

async function decodeTokenRefreshLog(
    log: RpcLog,
    collectionId: number,
    config: ReturnType<typeof parseTerraformsExtensionConfig>,
    rpc: RpcProviderPort,
): Promise<CollectionExtensionSyncDecodeResult> {
    const topic0 = log.topics[0];
    if (!topic0) {
        return emptyDecodeResult();
    }

    let metadataRefreshTokenId: string | null = null;
    let extensionEvent: CollectionExtensionEvent | null = null;
    let extensionEventMedia: CollectionExtensionEventMedia | null = null;
    let terraformedMaker: string | null = null;
    let isBeaconEvent = false;
    try {
        if (topic0 === DAYDREAMING_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_MAIN_ABI,
                eventName: "Daydreaming",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            metadataRefreshTokenId = decoded.args.tokenId.toString();
        } else if (topic0 === TERRAFORMED_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_MAIN_ABI,
                eventName: "Terraformed",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            metadataRefreshTokenId = decoded.args.tokenId.toString();
            terraformedMaker = decoded.args.terraformer.toLowerCase();
        } else if (topic0 === ATTUNEMENT_SET_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_TOKEN_URI_V2_ABI,
                eventName: "AttunementSet",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            metadataRefreshTokenId = decoded.args.tokenId.toString();
        } else if (BEACON_EVENT_TOPICS.has(topic0)) {
            isBeaconEvent = true;
        }
    } catch {
        return emptyDecodeResult();
    }

    if (terraformedMaker && metadataRefreshTokenId) {
        const terraformed = await buildTerraformedEventArtifacts({
            rpc,
            log,
            collectionId,
            mainContractAddress: config.mainContractAddress,
            rendererV2ContractAddress: config.rendererV2ContractAddress,
            tokenId: metadataRefreshTokenId,
            maker: terraformedMaker,
        });
        extensionEvent = terraformed.event;
        extensionEventMedia = terraformed.media;
    } else if (isBeaconEvent) {
        extensionEvent = await buildBeaconEvent({
            rpc,
            log,
            collectionId,
            beaconV2ContractAddress: config.beaconV2ContractAddress,
        });
        metadataRefreshTokenId = extensionEvent.tokenId ?? null;
    }

    if (!metadataRefreshTokenId && !extensionEvent) {
        return emptyDecodeResult();
    }
    const metadataRefreshEvents = metadataRefreshTokenId
        ? [
              buildMetadataRefreshEvent({
                  log,
                  collectionId,
                  mainContractAddress: config.mainContractAddress,
                  tokenId: metadataRefreshTokenId,
              }),
          ]
        : [];
    return {
        metadataRefreshEvents,
        metadataRefreshRangeEvents: [],
        collectionExtensionEvents: extensionEvent ? [extensionEvent] : [],
        collectionExtensionEventMedia: extensionEventMedia
            ? [extensionEventMedia]
            : [],
    };
}

function emptyDecodeResult(): CollectionExtensionSyncDecodeResult {
    return {
        metadataRefreshEvents: [],
        metadataRefreshRangeEvents: [],
        collectionExtensionEvents: [],
        collectionExtensionEventMedia: [],
    };
}

function buildMetadataRefreshEvent(params: {
    log: RpcLog;
    collectionId: number;
    mainContractAddress: string;
    tokenId: string;
}): MetadataRefreshEvent {
    return {
        collectionId: params.collectionId,
        contract: params.mainContractAddress.toLowerCase(),
        tokenId: params.tokenId,
        reason: "collection-extension",
        trigger: "terraforms.extension-event",
        blockNumber: params.log.blockNumber,
        blockHash: params.log.blockHash,
        txHash: params.log.transactionHash,
        logIndex: params.log.logIndex,
    };
}

async function buildBeaconEvent(params: {
    rpc: RpcProviderPort;
    log: RpcLog;
    collectionId: number;
    beaconV2ContractAddress: string;
}): Promise<CollectionExtensionEvent> {
    const topic0 = params.log.topics[0];
    if (!topic0) {
        throw new Error("Missing Terraforms beacon event topic");
    }

    // Beacon events do not include caller address, so we attribute via tx sender.
    const maker = (
        await params.rpc.getTransaction(params.log.transactionHash)
    ).from.toLowerCase();
    const base = buildBeaconEventBase({
        log: params.log,
        collectionId: params.collectionId,
        beaconV2ContractAddress: params.beaconV2ContractAddress,
        maker,
    });

    if (topic0 === PARCEL_MODIFIED_TOPIC) {
        const decoded = decodeEventLog({
            abi: TERRAFORMS_BEACON_V2_ABI,
            eventName: "ParcelModified",
            data: params.log.data,
            topics: params.log.topics as [Hex, ...Hex[]],
        });
        const modification = Number(decoded.args.modification);
        const eventType = TERRAFORMS_BEACON_EVENT_TYPES.ParcelModified;
        return {
            ...base,
            tokenId: decoded.args.tokenId.toString(),
            payload: {
                ...beaconPayloadBase({
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.ParcelModified,
                    eventType,
                }),
                tokenId: decoded.args.tokenId.toString(),
                modification,
                modificationLabel:
                    resolveAntennaModificationLabel(modification),
            },
        };
    }

    if (topic0 === BROADCAST_ADDED_TOPIC) {
        const decoded = decodeEventLog({
            abi: TERRAFORMS_BEACON_V2_ABI,
            eventName: "BroadcastAdded",
            data: params.log.data,
            topics: params.log.topics as [Hex, ...Hex[]],
        });
        const eventType = TERRAFORMS_BEACON_EVENT_TYPES.BroadcastAdded;
        return {
            ...base,
            tokenId: null,
            payload: {
                ...beaconPayloadBase({
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
                    eventType,
                }),
                satellite: decoded.args.satellite.toLowerCase(),
                duration: decoded.args.duration.toString(),
            },
        };
    }

    if (topic0 === BROADCAST_REMOVED_TOPIC) {
        const decoded = decodeEventLog({
            abi: TERRAFORMS_BEACON_V2_ABI,
            eventName: "BroadcastRemoved",
            data: params.log.data,
            topics: params.log.topics as [Hex, ...Hex[]],
        });
        const eventType = TERRAFORMS_BEACON_EVENT_TYPES.BroadcastRemoved;
        return {
            ...base,
            tokenId: null,
            payload: {
                ...beaconPayloadBase({
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
                    eventType,
                }),
                satellite: decoded.args.satellite.toLowerCase(),
            },
        };
    }

    if (topic0 === BROADCAST_MODIFIED_TOPIC) {
        const decoded = decodeEventLog({
            abi: TERRAFORMS_BEACON_V2_ABI,
            eventName: "BroadcastModified",
            data: params.log.data,
            topics: params.log.topics as [Hex, ...Hex[]],
        });
        const eventType = TERRAFORMS_BEACON_EVENT_TYPES.BroadcastModified;
        return {
            ...base,
            tokenId: null,
            payload: {
                ...beaconPayloadBase({
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
                    eventType,
                }),
                satellite: decoded.args.satellite.toLowerCase(),
                duration: decoded.args.duration.toString(),
            },
        };
    }

    if (topic0 === BROADCAST_ORDER_MODIFIED_TOPIC) {
        const decoded = decodeEventLog({
            abi: TERRAFORMS_BEACON_V2_ABI,
            eventName: "BroadcastOrderModified",
            data: params.log.data,
            topics: params.log.topics as [Hex, ...Hex[]],
        });
        const eventType = TERRAFORMS_BEACON_EVENT_TYPES.BroadcastOrderModified;
        return {
            ...base,
            tokenId: null,
            payload: {
                ...beaconPayloadBase({
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
                    eventType,
                }),
                order: decoded.args.order.map((value) => value.toString()),
            },
        };
    }

    if (topic0 === SCRIPT_COMPONENT_MODIFIED_TOPIC) {
        const decoded = decodeEventLog({
            abi: TERRAFORMS_BEACON_V2_ABI,
            eventName: "ScriptComponentModified",
            data: params.log.data,
            topics: params.log.topics as [Hex, ...Hex[]],
        });
        const componentType = Number(decoded.args.componentType);
        const eventType = TERRAFORMS_BEACON_EVENT_TYPES.ScriptComponentModified;
        return {
            ...base,
            tokenId: null,
            payload: {
                ...beaconPayloadBase({
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
                    eventType,
                }),
                componentType,
                componentLabel: resolveScriptComponentLabel(componentType),
                index: decoded.args.index.toString(),
            },
        };
    }

    throw new Error("Unsupported Terraforms beacon event");
}

function buildBeaconEventBase(params: {
    log: RpcLog;
    collectionId: number;
    beaconV2ContractAddress: string;
    maker: string;
}): Omit<CollectionExtensionEvent, "tokenId" | "payload"> {
    return {
        collectionId: params.collectionId,
        contract: params.beaconV2ContractAddress.toLowerCase(),
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
        maker: params.maker,
        contentHash: null,
        blockNumber: params.log.blockNumber,
        blockHash: params.log.blockHash,
        txHash: params.log.transactionHash,
        logIndex: params.log.logIndex,
    };
}

function beaconPayloadBase(params: {
    eventGroup: string;
    eventType: string;
}): Record<string, unknown> {
    return {
        eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
        eventGroup: params.eventGroup,
        eventType: params.eventType,
        eventLabel: TERRAFORMS_BEACON_EVENT_TYPE_LABELS[params.eventType],
    };
}

function resolveAntennaModificationLabel(value: number): string {
    return (
        TERRAFORMS_BEACON_ANTENNA_MODIFICATION_LABELS[value] ??
        `modification ${value}`
    );
}

function resolveScriptComponentLabel(value: number): string {
    return (
        TERRAFORMS_BEACON_SCRIPT_COMPONENT_LABELS[value] ?? `component ${value}`
    );
}

async function buildTerraformedEventArtifacts(params: {
    rpc: RpcProviderPort;
    log: RpcLog;
    collectionId: number;
    mainContractAddress: string;
    rendererV2ContractAddress: string;
    tokenId: string;
    maker: string;
}): Promise<{
    event: CollectionExtensionEvent;
    media: CollectionExtensionEventMedia;
}> {
    // Read the post-write block state so the immutable event carries its canvas.
    const canvas = await readCanvasRowsAtBlock(
        params.rpc,
        params.mainContractAddress,
        BigInt(params.tokenId),
        params.log.blockNumber,
    );
    const canvasRows = normalizeCanvas(canvas);
    const canvasHash = hashTerraformsCanvasRows(canvasRows);
    const renderArgs = await readTerraformedRenderArgsAtBlock({
        rpc: params.rpc,
        mainContractAddress: params.mainContractAddress,
        tokenId: BigInt(params.tokenId),
        blockNumber: params.log.blockNumber,
        canvas: canvasRows,
    });
    const svg = await params.rpc.readContract<string>({
        address: params.rendererV2ContractAddress as Hex,
        abi: TERRAFORMS_RENDERER_ABI,
        functionName: "tokenSVG",
        args: [
            renderArgs.status,
            renderArgs.placement,
            renderArgs.seed,
            renderArgs.decay,
            renderArgs.canvas,
        ],
    });

    const base = {
        collectionId: params.collectionId,
        contract: params.mainContractAddress.toLowerCase(),
        tokenId: params.tokenId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
        blockNumber: params.log.blockNumber,
        blockHash: params.log.blockHash,
        txHash: params.log.transactionHash,
        logIndex: params.log.logIndex,
    };
    return {
        event: {
            ...base,
            maker: params.maker,
            contentHash: canvasHash,
            payload: {
                eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
                contentHash: canvasHash,
                canvasHash,
                canvasRows: canvasRows.map((row) => row.toString()),
            },
        },
        media: {
            ...base,
            mediaRef: TERRAFORMS_EXTENSION_EVENT_MEDIA_REFS.TerraformedPreview,
            image: buildSvgDataUrl(svg),
            animationUrl: null,
            htmlContent: null,
            renderModes: TERRAFORMS_EVENT_RENDER_MODE_OPTIONS.map((mode) => ({
                ...mode,
            })),
        },
    };
}

async function readTerraformedRenderArgsAtBlock(params: {
    rpc: RpcProviderPort;
    mainContractAddress: string;
    tokenId: bigint;
    blockNumber: number;
    canvas: bigint[];
}): Promise<{
    status: bigint;
    placement: bigint;
    seed: bigint;
    decay: bigint;
    canvas: bigint[];
}> {
    // Read current status only to preserve origin lineage in renderer args.
    const [placement, tokenStatus] = await Promise.all([
        params.rpc.readContract<bigint>({
            address: params.mainContractAddress as Hex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToPlacement",
            args: [params.tokenId],
            blockNumber: params.blockNumber,
        }),
        params.rpc.readContract<bigint | number>({
            address: params.mainContractAddress as Hex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToStatus",
            args: [params.tokenId],
        }),
    ]);

    return {
        status: resolveTerraformsCommittedCanvasStatus(tokenStatus),
        placement,
        seed: TERRAFORMS_PLACEMENT_SEED,
        decay: DEFAULT_DECAY,
        canvas: normalizeCanvas(params.canvas),
    };
}

function buildSvgDataUrl(svg: string): string {
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString(
        "base64",
    )}`;
}

async function readCanvasRowsAtBlock(
    rpc: RpcProviderPort,
    mainContractAddress: string,
    tokenId: bigint,
    blockNumber: number,
): Promise<bigint[]> {
    const rows: bigint[] = [];
    for (let index = 0; index < TERRAFORMS_CANVAS_ROW_COUNT; index += 1) {
        const value = await rpc.readContract<bigint>({
            address: mainContractAddress as Hex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToCanvasData",
            args: [tokenId, BigInt(index)],
            blockNumber,
        });
        rows.push(value);
    }
    return rows;
}

function resolveStatusFromMode(mode: string): TerraformsStatus {
    const status = MODE_TO_STATUS[mode];
    if (!status) {
        throw new Error(`Unsupported Terraforms mode: ${mode}`);
    }
    return status;
}

async function upsertRenderedArtifact(
    context: CollectionExtensionArtifactRefreshContext,
    params: {
        rendererV2ContractAddress: string;
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        rendererTokenId: bigint;
        artifactRef: string;
        renderArgs: {
            status: bigint;
            placement: bigint;
            seed: bigint;
            decay: bigint;
            canvas: bigint[];
        };
        metadataFetchFailureMessage: string;
        htmlFetchFailureMessage: string;
    },
): Promise<TokenMetadata> {
    const uri = await context.rpc.readContract<string>({
        address: params.rendererV2ContractAddress as Hex,
        abi: TERRAFORMS_RENDERER_ABI,
        functionName: "tokenURI",
        args: [
            params.rendererTokenId,
            params.renderArgs.status,
            params.renderArgs.placement,
            params.renderArgs.seed,
            params.renderArgs.decay,
            params.renderArgs.canvas,
        ],
    });
    const metadata = await context.metadataFetcher.fetchMetadata(uri);
    if (!metadata) {
        throw new Error(params.metadataFetchFailureMessage);
    }

    const htmlContent = await context.rpc.readContract<string>({
        address: params.rendererV2ContractAddress as Hex,
        abi: TERRAFORMS_RENDERER_ABI,
        functionName: "tokenHTML",
        args: [
            params.renderArgs.status,
            params.renderArgs.placement,
            params.renderArgs.seed,
            params.renderArgs.decay,
            params.renderArgs.canvas,
        ],
    });
    if (typeof htmlContent !== "string" || htmlContent.length === 0) {
        throw new Error(params.htmlFetchFailureMessage);
    }

    context.artifacts.upsertArtifact({
        chainId: params.chainId,
        collectionId: params.collectionId,
        contractAddress: params.contract,
        tokenId: params.tokenId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        artifactRef: params.artifactRef,
        uri,
        rawJson: metadata.rawJson,
        attributesJson: JSON.stringify(metadata.attributes ?? []),
        image: metadata.image ?? null,
        animationUrl: metadata.animationUrl ?? null,
        htmlContent,
    });
    return metadata;
}

async function resolveRendererArgs(
    context: CollectionExtensionArtifactRefreshContext,
    params: {
        mainContractAddress: string;
        rendererV2ContractAddress: string;
        tokenId: bigint;
        placement: bigint;
        seed: bigint;
        status: TerraformsStatus;
    },
): Promise<{
    status: bigint;
    placement: bigint;
    seed: bigint;
    decay: bigint;
    canvas: bigint[];
}> {
    const isDaydream =
        params.status.slug === TERRAFORMS_STATUS_SLUG.Daydream ||
        params.status.slug === TERRAFORMS_STATUS_SLUG.OriginDaydream;

    if (isDaydream) {
        const zeroCanvas = Array.from(
            { length: TERRAFORMS_CANVAS_ROW_COUNT },
            () => 0n,
        );
        const indices = (await context.rpc.readContract<
            readonly (readonly bigint[])[]
        >({
            address: params.rendererV2ContractAddress as Hex,
            abi: TERRAFORMS_RENDERER_ABI,
            functionName: "tokenHeightmapIndices",
            args: [
                0n,
                params.placement,
                params.seed,
                DEFAULT_DECAY,
                zeroCanvas,
            ],
        })) as readonly (readonly bigint[])[];

        return {
            status:
                params.status.slug === TERRAFORMS_STATUS_SLUG.Daydream
                    ? 2n
                    : 4n,
            placement: params.placement,
            seed: params.seed,
            decay: DEFAULT_DECAY,
            canvas: normalizeCanvas(packHeightmapIndices(indices)),
        };
    }

    if (params.status.slug === TERRAFORMS_STATUS_SLUG.Terrain) {
        return resolveTerrainRendererArgs({
            placement: params.placement,
            seed: params.seed,
        });
    }

    const canvas = await readCanvasRows(
        context,
        params.mainContractAddress,
        params.tokenId,
    );

    return {
        status: params.status.value,
        placement: params.placement,
        seed: params.seed,
        decay: DEFAULT_DECAY,
        canvas,
    };
}

function resolveTerrainRendererArgs(params: {
    placement: bigint;
    seed: bigint;
}): {
    status: bigint;
    placement: bigint;
    seed: bigint;
    decay: bigint;
    canvas: bigint[];
} {
    return {
        status: 0n,
        placement: params.placement,
        seed: params.seed,
        decay: DEFAULT_DECAY,
        canvas: Array.from({ length: TERRAFORMS_CANVAS_ROW_COUNT }, () => 0n),
    };
}

async function readCanvasRows(
    context: CollectionExtensionArtifactRefreshContext,
    mainContractAddress: string,
    tokenId: bigint,
): Promise<bigint[]> {
    const rows: bigint[] = [];
    for (let index = 0; index < TERRAFORMS_CANVAS_ROW_COUNT; index += 1) {
        try {
            const value = await context.rpc.readContract<bigint>({
                address: mainContractAddress as Hex,
                abi: TERRAFORMS_MAIN_ABI,
                functionName: "tokenToCanvasData",
                args: [tokenId, BigInt(index)],
            });
            rows.push(value);
        } catch {
            rows.push(0n);
        }
    }
    return normalizeCanvas(rows);
}

function normalizeCanvas(rows: bigint[]): bigint[] {
    return normalizeTerraformsCanvasRows(rows);
}

function packHeightmapIndices(
    indices: readonly (readonly bigint[])[],
): bigint[] {
    const rows: bigint[] = [];
    const numRows = indices.length;
    for (let pair = 0; pair < TERRAFORMS_CANVAS_ROW_COUNT; pair += 1) {
        const rowA = indices[pair * 2] ?? [];
        const rowB = indices[pair * 2 + 1] ?? [];
        let packed = 0n;
        for (let column = 0; column < 32; column += 1) {
            packed = packed * 10n + (rowA[column] ?? 0n);
        }
        for (let column = 0; column < 32; column += 1) {
            packed = packed * 10n + (rowB[column] ?? 0n);
        }
        rows.push(packed);
    }
    if (numRows === 0) {
        return Array.from({ length: TERRAFORMS_CANVAS_ROW_COUNT }, () => 0n);
    }
    return rows;
}
