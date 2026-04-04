import {
    COLLECTION_EXTENSION_KEYS,
    parseTerraformsExtensionConfig,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    type CollectionExtensionInstall,
} from "@artgod/shared/extensions";
import { logger } from "@artgod/shared/utils";
import { decodeEventLog, encodeEventTopics } from "viem";
import type {
    MetadataRefreshEvent,
    MetadataRefreshRangeEvent,
} from "../../domain/onchain.js";
import type {
    CollectionExtensionArtifactRefreshContext,
    CollectionExtensionSyncDecodeResult,
    CollectionExtensionSyncWatchSpec,
    IndexerCollectionExtension,
} from "./types.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";

const MODE_ATTRIBUTE_KEY = "Mode";
const DEFAULT_DECAY = 0n;

const TERRAFORMS_MAIN_ABI = [
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
        name: "seed",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
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
    Terrain: { slug: TERRAFORMS_STATUS_SLUG.Terrain, value: 0n },
    Daydream: { slug: TERRAFORMS_STATUS_SLUG.Daydream, value: 1n },
    Terraform: { slug: TERRAFORMS_STATUS_SLUG.Terraform, value: 2n },
    "Origin Daydream": {
        slug: TERRAFORMS_STATUS_SLUG.OriginDaydream,
        value: 3n,
    },
    "Origin Terraform": {
        slug: TERRAFORMS_STATUS_SLUG.OriginTerraform,
        value: 4n,
    },
};

export const terraformsIndexerExtension: IndexerCollectionExtension = {
    key: COLLECTION_EXTENSION_KEYS.Terraforms,
    buildSyncWatchSpecs(install: CollectionExtensionInstall) {
        const config = parseTerraformsExtensionConfig(install.configJson);
        return [
            {
                collectionId: install.collectionId,
                sourceId: "terraforms-main",
                address: config.mainContractAddress as Hex,
                events: [
                    TERRAFORMS_MAIN_ABI[3],
                    TERRAFORMS_MAIN_ABI[4],
                ] as const,
                decode: (log) =>
                    decodeTokenRefreshLog(
                        log,
                        install.collectionId,
                        config.mainContractAddress,
                    ),
            },
            {
                collectionId: install.collectionId,
                sourceId: "terraforms-token-uri-v2",
                address: config.tokenUriV2ContractAddress as Hex,
                events: [TERRAFORMS_TOKEN_URI_V2_ABI[0]] as const,
                decode: (log) =>
                    decodeTokenRefreshLog(
                        log,
                        install.collectionId,
                        config.mainContractAddress,
                    ),
            },
            {
                collectionId: install.collectionId,
                sourceId: "terraforms-beacon-v2",
                address: config.beaconV2ContractAddress as Hex,
                events: [TERRAFORMS_BEACON_V2_ABI[0]] as const,
                decode: (log) =>
                    decodeTokenRefreshLog(
                        log,
                        install.collectionId,
                        config.mainContractAddress,
                    ),
            },
        ];
    },
    async refreshArtifacts(context: CollectionExtensionArtifactRefreshContext) {
        const config = parseTerraformsExtensionConfig(
            context.install.configJson,
        );
        const tokenId = context.payload.tokenId;
        const contract = context.payload.contract.toLowerCase();
        const tokenMode = context.artifacts.getTokenAttributeValue({
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            tokenId,
            key: MODE_ATTRIBUTE_KEY,
        });
        if (!tokenMode) {
            throw new Error(
                `Terraforms mode attribute missing for token ${contract}:${tokenId}`,
            );
        }

        const status = resolveStatusFromMode(tokenMode);
        const seed = await context.rpc.readContract<bigint>({
            address: config.mainContractAddress as Hex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "seed",
        });
        const placement = await context.rpc.readContract<bigint>({
            address: config.mainContractAddress as Hex,
            abi: TERRAFORMS_MAIN_ABI,
            functionName: "tokenToPlacement",
            args: [BigInt(tokenId)],
        });

        const currentRenderArgs = await resolveRendererArgs(context, {
            mainContractAddress: config.mainContractAddress,
            rendererV2ContractAddress: config.rendererV2ContractAddress,
            tokenId: BigInt(tokenId),
            placement,
            seed,
            status,
        });
        await upsertRenderedArtifact(context, {
            rendererV2ContractAddress: config.rendererV2ContractAddress,
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            contract,
            tokenId,
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
                artifactRef:
                    TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
                renderArgs: resolveTerrainRendererArgs({ placement, seed }),
                metadataFetchFailureMessage: `Terraforms lost terrain metadata fetch failed for token ${contract}:${tokenId}`,
                htmlFetchFailureMessage: `Terraforms lost terrain HTML fetch failed for token ${contract}:${tokenId}`,
            });
            lostTerrainWritten = true;
        }

        logger.debug("Terraforms extension artifacts refreshed", {
            component: "CollectionExtensions",
            action: "terraforms.refreshArtifacts",
            chainId: context.payload.chainId,
            collectionId: context.payload.collectionId,
            contract,
            tokenId,
            reason: context.payload.reason,
            mode: tokenMode,
            status: currentRenderArgs.status.toString(),
            lostTerrainWritten,
        });
    },
};

function decodeTokenRefreshLog(
    log: RpcLog,
    collectionId: number,
    targetContract: string,
): CollectionExtensionSyncDecodeResult {
    const topic0 = log.topics[0];
    if (!topic0) {
        return emptyDecodeResult();
    }

    let tokenId: string | null = null;
    try {
        if (topic0 === DAYDREAMING_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_MAIN_ABI,
                eventName: "Daydreaming",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            tokenId = decoded.args.tokenId.toString();
        } else if (topic0 === TERRAFORMED_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_MAIN_ABI,
                eventName: "Terraformed",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            tokenId = decoded.args.tokenId.toString();
        } else if (topic0 === ATTUNEMENT_SET_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_TOKEN_URI_V2_ABI,
                eventName: "AttunementSet",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            tokenId = decoded.args.tokenId.toString();
        } else if (topic0 === PARCEL_MODIFIED_TOPIC) {
            const decoded = decodeEventLog({
                abi: TERRAFORMS_BEACON_V2_ABI,
                eventName: "ParcelModified",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            tokenId = decoded.args.tokenId.toString();
        }
    } catch {
        return emptyDecodeResult();
    }

    if (!tokenId) {
        return emptyDecodeResult();
    }

    const event: MetadataRefreshEvent = {
        collectionId,
        contract: targetContract.toLowerCase(),
        tokenId,
        reason: "collection-extension",
        trigger: "terraforms.extension-event",
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
    };
    return {
        metadataRefreshEvents: [event],
        metadataRefreshRangeEvents: [],
    };
}

function emptyDecodeResult(): CollectionExtensionSyncDecodeResult {
    return {
        metadataRefreshEvents: [],
        metadataRefreshRangeEvents: [],
    };
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
): Promise<void> {
    const uri = await context.rpc.readContract<string>({
        address: params.rendererV2ContractAddress as Hex,
        abi: TERRAFORMS_RENDERER_ABI,
        functionName: "tokenURI",
        args: [
            BigInt(params.tokenId),
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
        extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
        artifactRef: params.artifactRef,
        uri,
        rawJson: metadata.rawJson,
        attributesJson: JSON.stringify(metadata.attributes ?? []),
        image: metadata.image ?? null,
        animationUrl: metadata.animationUrl ?? null,
        htmlContent,
    });
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
        const zeroCanvas = Array.from({ length: 16 }, () => 0n);
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
        canvas: Array.from({ length: 16 }, () => 0n),
    };
}

async function readCanvasRows(
    context: CollectionExtensionArtifactRefreshContext,
    mainContractAddress: string,
    tokenId: bigint,
): Promise<bigint[]> {
    const rows: bigint[] = [];
    for (let index = 0; index < 16; index += 1) {
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
    const output = [...rows];
    while (output.length < 16) {
        output.push(0n);
    }
    return output.slice(0, 16);
}

function packHeightmapIndices(
    indices: readonly (readonly bigint[])[],
): bigint[] {
    const rows: bigint[] = [];
    const numRows = indices.length;
    for (let pair = 0; pair < 16; pair += 1) {
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
        return Array.from({ length: 16 }, () => 0n);
    }
    return rows;
}
