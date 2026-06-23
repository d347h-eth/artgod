import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import {
    buildTerraformsUnmintedTokenId,
    TERRAFORMS_BIOME_ATTRIBUTE_KEY,
    TERRAFORMS_BEACON_ANTENNA_MODIFICATION_LABELS,
    TERRAFORMS_BEACON_EVENT_GROUPS,
    TERRAFORMS_BEACON_EVENT_TYPES,
    TERRAFORMS_BEACON_SCRIPT_COMPONENT_LABELS,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_MINTED_ATTRIBUTE_KEY,
    TERRAFORMS_MINTED_ATTRIBUTE_VALUES,
    TERRAFORMS_MODE_ATTRIBUTE_KEY,
    TERRAFORMS_MODE_ATTRIBUTE_VALUES,
    TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
    TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
    TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES,
    TERRAFORMS_ZONE_ATTRIBUTE_KEY,
} from "@artgod/shared/extensions/terraforms";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
import {
    buildTerraformsUnmintedTokenAttributes,
    terraformsIndexerExtension,
} from "../src/application/collection-extensions/terraforms.js";
import { SqliteCollectionExtensions } from "../src/infra/collection-extensions/sqlite.js";
import { HttpMetadataFetcher } from "../src/infra/metadata/http-fetcher.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";

const TERRAFORMS_ADDRESS = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const TERRAFORMS_RENDERER_V2_ADDRESS =
    "0x8af860c8f157f4e3b6a54913bfa6bb96ab2605c2";
const TERRAFORMS_TOKEN_URI_V2_ADDRESS =
    "0xfca647387e28e73e291dd90e7b09fa32bcbb2604";
const TERRAFORMS_BEACON_V2_ADDRESS =
    "0x331512a28a4cf80221af949b5d43041ff0fc7f01";

type ArtifactDebugColumnRow = {
    uri: string | null;
    raw_json: string | null;
    attributes_json: string | null;
};

let dbPath = "";

beforeAll(async () => {
    dbPath = path.join(
        os.tmpdir(),
        `artgod-collection-extensions-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    setDbPath(dbPath);
    await createMigrationRunner().runMigrations();
});

afterAll(async () => {
    await Promise.all([
        fs.rm(dbPath, { force: true }),
        fs.rm(`${dbPath}-shm`, { force: true }),
        fs.rm(`${dbPath}-wal`, { force: true }),
    ]);
});

describe("terraforms collection extension", () => {
    it("decodes sync watch logs into token metadata refresh triggers", async () => {
        const specs = terraformsIndexerExtension.buildSyncWatchSpecs(
            buildInstall(1),
        );
        const [daydreamingTopic] = encodeEventTopics({
            abi: [
                {
                    name: "Daydreaming",
                    type: "event",
                    anonymous: false,
                    inputs: [
                        { indexed: false, name: "tokenId", type: "uint256" },
                    ],
                },
            ],
            eventName: "Daydreaming",
        }) as [`0x${string}`];

        expect(specs.map((spec) => spec.sourceId)).toEqual([
            "terraforms-main",
            "terraforms-token-uri-v2",
            "terraforms-beacon-v2",
        ]);

        const decoded = await specs[0]!.decode(
            {
                address: TERRAFORMS_ADDRESS as `0x${string}`,
                topics: [daydreamingTopic],
                data: encodeAbiParameters([{ type: "uint256" }], [7710n]),
                blockNumber: 101,
                blockHash: `0x${"11".repeat(32)}`,
                transactionHash: `0x${"22".repeat(32)}`,
                logIndex: 3,
            },
            { rpc: createRpcStub({ onReadContract: unexpectedReadContract }) },
        );

        expect(decoded.metadataRefreshEvents).toEqual([
            expect.objectContaining({
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7710",
                reason: "collection-extension",
                trigger: "terraforms.extension-event",
            }),
        ]);
        expect(decoded.metadataRefreshRangeEvents).toEqual([]);
        expect(decoded.collectionExtensionEvents).toEqual([]);
    });

    it("seeds unminted bootstrap artifact tasks from minted placements", async () => {
        const seededRows: Array<{
            tokenId: string;
            contract: string;
            extensionKey: string;
        }> = [];
        const rpc = createRpcStub({
            onReadContract({ functionName, args }) {
                if (functionName === "totalSupply") {
                    return 2n;
                }
                if (functionName === "tokenToPlacement") {
                    return args?.[0] === 1n ? 0n : 2n;
                }
                throw new Error(`Unexpected contract call: ${functionName}`);
            },
        });

        const result =
            await terraformsIndexerExtension.seedBootstrapArtifactTasks?.({
                rpc,
                install: buildInstall(7),
                tasks: {
                    insertCollectionExtensionArtifactTasks(rows) {
                        seededRows.push(...rows);
                        return rows.length;
                    },
                },
                run: {
                    runId: 41,
                    chainId: 1,
                    collectionId: 7,
                    contract: TERRAFORMS_ADDRESS,
                },
            });

        expect(result).toEqual({ tasksSeeded: 11102 });
        expect(seededRows[0]).toMatchObject({
            tokenId: buildTerraformsUnmintedTokenId(1n),
            contract: TERRAFORMS_ADDRESS,
            extensionKey: TERRAFORMS_EXTENSION_KEY,
        });
        expect(
            seededRows.some(
                (row) => row.tokenId === buildTerraformsUnmintedTokenId(0n),
            ),
        ).toBe(false);
        expect(
            seededRows.some(
                (row) => row.tokenId === buildTerraformsUnmintedTokenId(2n),
            ),
        ).toBe(false);
    });

    it("decodes Terraformed logs into extension event facts", async () => {
        const specs = terraformsIndexerExtension.buildSyncWatchSpecs(
            buildInstall(1),
        );
        const [terraformedTopic] = encodeEventTopics({
            abi: [
                {
                    name: "Terraformed",
                    type: "event",
                    anonymous: false,
                    inputs: [
                        { indexed: false, name: "tokenId", type: "uint256" },
                        {
                            indexed: false,
                            name: "terraformer",
                            type: "address",
                        },
                    ],
                },
            ],
            eventName: "Terraformed",
        }) as [`0x${string}`];
        const blockScopedCalls: Array<{
            functionName: string;
            blockNumber?: number;
        }> = [];
        const tokenSvgArgs: unknown[][] = [];

        const decoded = await specs[0]!.decode(
            {
                address: TERRAFORMS_ADDRESS as `0x${string}`,
                topics: [terraformedTopic],
                data: encodeAbiParameters(
                    [{ type: "uint256" }, { type: "address" }],
                    [7710n, "0x9999999999999999999999999999999999999999"],
                ),
                blockNumber: 101,
                blockHash: `0x${"11".repeat(32)}`,
                transactionHash: `0x${"22".repeat(32)}`,
                logIndex: 3,
            },
            {
                rpc: createRpcStub({
                    onReadContract({ functionName, args, blockNumber }) {
                        blockScopedCalls.push({ functionName, blockNumber });
                        if (functionName === "tokenToCanvasData") {
                            return (args?.[1] as bigint) + 1n;
                        }
                        if (functionName === "tokenToPlacement") {
                            return 42n;
                        }
                        if (functionName === "tokenToStatus") {
                            return 4n;
                        }
                        if (functionName === "tokenSVG") {
                            tokenSvgArgs.push([...(args ?? [])]);
                            return "<svg>terraformed</svg>";
                        }
                        throw new Error(
                            `Unexpected contract call: ${functionName}`,
                        );
                    },
                }),
            },
        );

        expect(decoded.collectionExtensionEvents).toEqual([
            expect.objectContaining({
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                eventKey: "terraformed",
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7710",
                maker: "0x9999999999999999999999999999999999999999",
                blockNumber: 101,
            }),
        ]);
        const event = decoded.collectionExtensionEvents[0]!;
        expect(event.contentHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(event.payload).toMatchObject({
            eventKey: "terraformed",
            contentHash: event.contentHash,
            canvasHash: event.contentHash,
        });
        expect(event.payload).not.toHaveProperty("status");
        expect(
            (event.payload?.canvasRows as string[] | undefined)?.length,
        ).toBe(16);
        expect(decoded.collectionExtensionEventMedia).toEqual([
            expect.objectContaining({
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                eventKey: "terraformed",
                tokenId: "7710",
                image: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
            }),
        ]);
        expect(
            blockScopedCalls.filter(
                (call) => call.functionName === "tokenToCanvasData",
            ),
        ).toHaveLength(16);
        expect(
            blockScopedCalls
                .filter(
                    (call) =>
                        call.functionName !== "tokenSVG" &&
                        call.functionName !== "tokenToStatus",
                )
                .every((call) => call.blockNumber === 101),
        ).toBe(true);
        expect(
            blockScopedCalls.find((call) => call.functionName === "tokenSVG")
                ?.blockNumber,
        ).toBeUndefined();
        expect(blockScopedCalls.map((call) => call.functionName)).toEqual(
            expect.arrayContaining([
                "tokenToPlacement",
                "tokenToStatus",
                "tokenSVG",
            ]),
        );
        expect(tokenSvgArgs[0]?.[0]).toBe(4n);
    });

    it("decodes ParcelModified logs into beacon event facts and metadata refresh triggers", async () => {
        const specs = terraformsIndexerExtension.buildSyncWatchSpecs(
            buildInstall(1),
        );
        const [parcelModifiedTopic] = encodeEventTopics({
            abi: [
                {
                    name: "ParcelModified",
                    type: "event",
                    anonymous: false,
                    inputs: [
                        { indexed: false, name: "tokenId", type: "uint256" },
                        { indexed: false, name: "modification", type: "uint8" },
                    ],
                },
            ],
            eventName: "ParcelModified",
        }) as [`0x${string}`];

        const decoded = await specs[2]!.decode(
            {
                address: TERRAFORMS_BEACON_V2_ADDRESS as `0x${string}`,
                topics: [parcelModifiedTopic],
                data: encodeAbiParameters(
                    [{ type: "uint256" }, { type: "uint8" }],
                    [7710n, 1],
                ),
                blockNumber: 101,
                blockHash: `0x${"11".repeat(32)}`,
                transactionHash: `0x${"22".repeat(32)}`,
                logIndex: 4,
            },
            {
                rpc: createRpcStub({
                    onReadContract: unexpectedReadContract,
                    onGetTransaction: () => ({
                        from: "0x8888888888888888888888888888888888888888",
                    }),
                }),
            },
        );

        expect(decoded.metadataRefreshEvents).toEqual([
            expect.objectContaining({
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7710",
                trigger: "terraforms.extension-event",
            }),
        ]);
        expect(decoded.collectionExtensionEvents).toEqual([
            expect.objectContaining({
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
                contract: TERRAFORMS_BEACON_V2_ADDRESS,
                tokenId: "7710",
                maker: "0x8888888888888888888888888888888888888888",
            }),
        ]);
        expect(decoded.collectionExtensionEvents[0]!.payload).toMatchObject({
            eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
            eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.ParcelModified,
            eventType: TERRAFORMS_BEACON_EVENT_TYPES.ParcelModified,
            tokenId: "7710",
            modification: 1,
            modificationLabel: TERRAFORMS_BEACON_ANTENNA_MODIFICATION_LABELS[1],
        });
        expect(decoded.collectionExtensionEventMedia).toEqual([]);
    });

    it("decodes Mathcastles beacon admin logs into collection-scoped event facts", async () => {
        const specs = terraformsIndexerExtension.buildSyncWatchSpecs(
            buildInstall(1),
        );
        const cases = [
            {
                eventName: "BroadcastAdded",
                inputs: [
                    { indexed: false, name: "satellite", type: "address" },
                    { indexed: false, name: "duration", type: "uint256" },
                ],
                values: ["0x7777777777777777777777777777777777777777", 3600n],
                expectedPayload: {
                    eventType: TERRAFORMS_BEACON_EVENT_TYPES.BroadcastAdded,
                    satellite: "0x7777777777777777777777777777777777777777",
                    duration: "3600",
                },
            },
            {
                eventName: "BroadcastRemoved",
                inputs: [
                    { indexed: false, name: "satellite", type: "address" },
                ],
                values: ["0x7777777777777777777777777777777777777777"],
                expectedPayload: {
                    eventType: TERRAFORMS_BEACON_EVENT_TYPES.BroadcastRemoved,
                    satellite: "0x7777777777777777777777777777777777777777",
                },
            },
            {
                eventName: "BroadcastModified",
                inputs: [
                    { indexed: false, name: "satellite", type: "address" },
                    { indexed: false, name: "duration", type: "uint256" },
                ],
                values: ["0x7777777777777777777777777777777777777777", 7200n],
                expectedPayload: {
                    eventType: TERRAFORMS_BEACON_EVENT_TYPES.BroadcastModified,
                    satellite: "0x7777777777777777777777777777777777777777",
                    duration: "7200",
                },
            },
            {
                eventName: "BroadcastOrderModified",
                inputs: [{ indexed: false, name: "order", type: "uint256[]" }],
                values: [[2n, 0n, 1n]],
                expectedPayload: {
                    eventType:
                        TERRAFORMS_BEACON_EVENT_TYPES.BroadcastOrderModified,
                    order: ["2", "0", "1"],
                },
            },
            {
                eventName: "ScriptComponentModified",
                inputs: [
                    { indexed: false, name: "componentType", type: "uint8" },
                    { indexed: false, name: "index", type: "uint256" },
                ],
                values: [3, 9n],
                expectedPayload: {
                    eventType:
                        TERRAFORMS_BEACON_EVENT_TYPES.ScriptComponentModified,
                    componentType: 3,
                    componentLabel:
                        TERRAFORMS_BEACON_SCRIPT_COMPONENT_LABELS[3],
                    index: "9",
                },
            },
        ] as const;

        for (const [index, testCase] of cases.entries()) {
            const abi = [
                {
                    name: testCase.eventName,
                    type: "event",
                    anonymous: false,
                    inputs: testCase.inputs,
                },
            ] as const;
            const [topic] = encodeEventTopics({
                abi,
                eventName: testCase.eventName,
            }) as [`0x${string}`];

            const decoded = await specs[2]!.decode(
                {
                    address: TERRAFORMS_BEACON_V2_ADDRESS as `0x${string}`,
                    topics: [topic],
                    data: encodeAbiParameters(
                        testCase.inputs.map((input) => ({
                            type: input.type,
                        })),
                        testCase.values,
                    ),
                    blockNumber: 101 + index,
                    blockHash: `0x${"11".repeat(32)}`,
                    transactionHash: `0x${"22".repeat(32)}`,
                    logIndex: 5 + index,
                },
                {
                    rpc: createRpcStub({
                        onReadContract: unexpectedReadContract,
                        onGetTransaction: () => ({
                            from: "0x9999999999999999999999999999999999999999",
                        }),
                    }),
                },
            );

            expect(decoded.metadataRefreshEvents).toEqual([]);
            expect(decoded.collectionExtensionEvents).toEqual([
                expect.objectContaining({
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                    eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
                    contract: TERRAFORMS_BEACON_V2_ADDRESS,
                    tokenId: null,
                    maker: "0x9999999999999999999999999999999999999999",
                }),
            ]);
            expect(decoded.collectionExtensionEvents[0]!.payload).toMatchObject(
                {
                    eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
                    eventGroup: TERRAFORMS_BEACON_EVENT_GROUPS.Mathcastles,
                    ...testCase.expectedPayload,
                },
            );
        }
    });

    it("persists current and lost-terrain v2 artifacts for terraform mode", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7710", "Terraform");

        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher();
        const tokenUriArgs: unknown[][] = [];
        const tokenHtmlArgs: unknown[][] = [];
        const canvasReads: bigint[] = [];
        const rpc = createRpcStub({
            onReadContract({ functionName, args }) {
                if (functionName === "tokenToPlacement") {
                    return 42n;
                }
                if (functionName === "tokenToCanvasData") {
                    const row = BigInt(args?.[1] as bigint);
                    canvasReads.push(row);
                    return row + 1n;
                }
                if (functionName === "tokenURI") {
                    tokenUriArgs.push([...(args ?? [])]);
                    if (tokenUriArgs.length === 2) {
                        return buildMetadataDataUri({
                            name: "Terraform #7710 lost",
                            image: "data:image/svg+xml;base64,terraform-lost",
                            animation_url:
                                "https://example.com/terraform-lost-animation",
                            attributes: [
                                { trait_type: "Mode", value: "Terrain" },
                            ],
                        });
                    }
                    return buildMetadataDataUri({
                        name: "Terraform #7710 v2",
                        image: "data:image/svg+xml;base64,terraform-v2",
                        animation_url:
                            "https://example.com/terraform-v2-animation",
                        attributes: [
                            { trait_type: "Mode", value: "Terraform" },
                        ],
                    });
                }
                if (functionName === "tokenHTML") {
                    tokenHtmlArgs.push([...(args ?? [])]);
                    if (tokenHtmlArgs.length === 2) {
                        return "<html><body>terraform-lost</body></html>";
                    }
                    return "<html><body>terraform-v2</body></html>";
                }
                throw new Error(`Unexpected contract call: ${functionName}`);
            },
        });

        const refreshResult = await terraformsIndexerExtension.refreshArtifacts(
            {
                rpc,
                metadataFetcher,
                installs: collectionExtensions,
                artifacts: collectionExtensions,
                attributes: collectionExtensions,
                syntheticTokens: collectionExtensions,
                install: buildInstall(collectionId),
                payload: {
                    chainId: 1,
                    collectionId,
                    contract: TERRAFORMS_ADDRESS,
                    tokenId: "7710",
                    reason: "bootstrap-snapshot",
                    source: "bootstrap",
                },
            },
        );
        expect(refreshResult.attributesChanged).toBe(true);

        const artifact = collectionExtensions.getArtifact({
            chainId: 1,
            collectionId,
            tokenId: "7710",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
        });

        expect(artifact).not.toBeNull();
        expect(artifact?.image).toBe("data:image/svg+xml;base64,terraform-v2");
        expect(artifact?.animationUrl).toBe(
            "https://example.com/terraform-v2-animation",
        );
        expect(artifact?.htmlContent).toBe(
            "<html><body>terraform-v2</body></html>",
        );
        expect(
            selectArtifactDebugColumns({
                collectionId,
                tokenId: "7710",
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            }),
        ).toEqual({
            uri: null,
            raw_json: null,
            attributes_json: null,
        });
        const lostArtifact = collectionExtensions.getArtifact({
            chainId: 1,
            collectionId,
            tokenId: "7710",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
        });
        expect(lostArtifact?.image).toBe(
            "data:image/svg+xml;base64,terraform-lost",
        );
        expect(lostArtifact?.htmlContent).toBe(
            "<html><body>terraform-lost</body></html>",
        );
        expect(
            selectArtifactDebugColumns({
                collectionId,
                tokenId: "7710",
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
            }),
        ).toEqual({
            uri: null,
            raw_json: null,
            attributes_json: null,
        });
        expect(canvasReads).toHaveLength(16);
        expect(tokenUriArgs[0]?.[1]).toBe(2n);
        expect(tokenUriArgs[1]?.[1]).toBe(0n);
        expect(tokenHtmlArgs[0]?.[0]).toBe(2n);
        expect(tokenHtmlArgs[1]?.[0]).toBe(0n);
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7710",
                key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
            }),
        ).toBe("9297");
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7710",
                key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
            }),
        ).toBeNull();
    });

    it("stores extension artifact debug columns when raw debug payload persistence is enabled", () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7710", "Terraform");

        const collectionExtensions = new SqliteCollectionExtensions({
            persistRawDebugPayloads: true,
        });
        collectionExtensions.upsertArtifact({
            chainId: 1,
            collectionId,
            contractAddress: TERRAFORMS_ADDRESS,
            tokenId: "7710",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            uri: "data:application/json;base64,debug",
            rawJson: JSON.stringify({ name: "Terraform #7710 v2" }),
            attributesJson: JSON.stringify([
                { traitType: "Mode", value: "Terraform" },
            ]),
            image: "data:image/svg+xml;base64,terraform-v2",
            animationUrl: "https://example.com/terraform-v2-animation",
            htmlContent: "<html><body>terraform-v2</body></html>",
        });

        const artifact = collectionExtensions.getArtifact({
            chainId: 1,
            collectionId,
            tokenId: "7710",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
        });

        expect(artifact).toEqual({
            chainId: 1,
            collectionId,
            contractAddress: TERRAFORMS_ADDRESS,
            tokenId: "7710",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            image: "data:image/svg+xml;base64,terraform-v2",
            animationUrl: "https://example.com/terraform-v2-animation",
            htmlContent: "<html><body>terraform-v2</body></html>",
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
        });
        expect(
            selectArtifactDebugColumns({
                collectionId,
                tokenId: "7710",
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            }),
        ).toEqual({
            uri: "data:application/json;base64,debug",
            raw_json: JSON.stringify({ name: "Terraform #7710 v2" }),
            attributes_json: JSON.stringify([
                { traitType: "Mode", value: "Terraform" },
            ]),
        });
    });

    it("uses terrain-derived canvas override for daydream mode", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7711", "Daydream");

        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher();
        const tokenUriArgs: unknown[][] = [];
        const tokenHtmlArgs: unknown[][] = [];
        let heightmapCalls = 0;
        let canvasReads = 0;
        const rpc = createRpcStub({
            onReadContract({ functionName, args }) {
                if (functionName === "tokenToPlacement") {
                    return 77n;
                }
                if (functionName === "tokenToCanvasData") {
                    canvasReads += 1;
                    return 999n;
                }
                if (functionName === "tokenHeightmapIndices") {
                    heightmapCalls += 1;
                    expect(args?.[0]).toBe(0n);
                    return Array.from({ length: 32 }, () =>
                        Array.from({ length: 32 }, () => 7n),
                    );
                }
                if (functionName === "tokenURI") {
                    tokenUriArgs.push([...(args ?? [])]);
                    return buildMetadataDataUri({
                        name: "Terraform #7711 v2",
                        image: "data:image/svg+xml;base64,daydream-v2",
                        animation_url:
                            "https://example.com/daydream-v2-animation",
                        attributes: [{ trait_type: "Mode", value: "Daydream" }],
                    });
                }
                if (functionName === "tokenHTML") {
                    tokenHtmlArgs.push([...(args ?? [])]);
                    return "<html><body>daydream-v2</body></html>";
                }
                throw new Error(`Unexpected contract call: ${functionName}`);
            },
        });

        await terraformsIndexerExtension.refreshArtifacts({
            rpc,
            metadataFetcher,
            installs: collectionExtensions,
            artifacts: collectionExtensions,
            attributes: collectionExtensions,
            syntheticTokens: collectionExtensions,
            install: buildInstall(collectionId),
            payload: {
                chainId: 1,
                collectionId,
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7711",
                reason: "erc4906",
                source: "onchain",
            },
        });

        const artifact = collectionExtensions.getArtifact({
            chainId: 1,
            collectionId,
            tokenId: "7711",
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
        });

        expect(artifact?.htmlContent).toBe(
            "<html><body>daydream-v2</body></html>",
        );
        expect(heightmapCalls).toBe(1);
        expect(canvasReads).toBe(0);
        expect(tokenUriArgs[0]?.[1]).toBe(2n);
        expect(tokenUriArgs[1]?.[1]).toBe(0n);
        expect(tokenHtmlArgs[0]?.[0]).toBe(2n);
        expect(tokenHtmlArgs[1]?.[0]).toBe(0n);
        expect((tokenUriArgs[0]?.[5] as bigint[] | undefined)?.length).toBe(16);
    });

    it("skips lost-terrain artifacts for terrain mode", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7712", "Terrain");

        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher();
        let canvasReads = 0;
        const tokenUriArgs: unknown[][] = [];
        const rpc = createRpcStub({
            onReadContract({ functionName, args }) {
                if (functionName === "tokenToPlacement") {
                    return 865n;
                }
                if (functionName === "tokenToCanvasData") {
                    canvasReads += 1;
                    return 123n;
                }
                if (functionName === "tokenURI") {
                    tokenUriArgs.push([...(args ?? [])]);
                    return buildMetadataDataUri({
                        name: "Terrain #7712 v2",
                        image: "data:image/svg+xml;base64,terrain-v2",
                        animation_url:
                            "https://example.com/terrain-v2-animation",
                        attributes: [{ trait_type: "Mode", value: "Terrain" }],
                    });
                }
                if (functionName === "tokenHTML") {
                    return "<html><body>terrain-v2</body></html>";
                }
                throw new Error(`Unexpected contract call: ${functionName}`);
            },
        });

        await terraformsIndexerExtension.refreshArtifacts({
            rpc,
            metadataFetcher,
            installs: collectionExtensions,
            artifacts: collectionExtensions,
            attributes: collectionExtensions,
            syntheticTokens: collectionExtensions,
            install: buildInstall(collectionId),
            payload: {
                chainId: 1,
                collectionId,
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7712",
                reason: "bootstrap-snapshot",
                source: "bootstrap",
            },
        });

        expect(canvasReads).toBe(0);
        expect(tokenUriArgs).toHaveLength(1);
        expect(tokenUriArgs[0]?.[1]).toBe(0n);
        expect(
            collectionExtensions.getArtifact({
                chainId: 1,
                collectionId,
                tokenId: "7712",
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
            }),
        ).toBeNull();
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7712",
                key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
            }),
        ).toBe("9964");
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7712",
                key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
            }),
        ).toBe(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed);
    });

    it("builds unminted attributes with Terrain mode regardless of renderer metadata mode", () => {
        const attributes = buildTerraformsUnmintedTokenAttributes({
            metadata: {
                uri: "data:application/json;base64,test",
                attributes: [
                    {
                        traitType: TERRAFORMS_MODE_ATTRIBUTE_KEY,
                        value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Daydream,
                    },
                    {
                        traitType: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
                        value: TERRAFORMS_MINTED_ATTRIBUTE_VALUES.True,
                    },
                    { traitType: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: "Alto" },
                ],
                rawJson: "{}",
            },
            seed: 4117n,
            seedClass: null,
        });

        expect(attributes).toEqual([
            {
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
                value: TERRAFORMS_MINTED_ATTRIBUTE_VALUES.False,
            },
            {
                key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
                value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
            },
            { key: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: "Alto" },
            {
                key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
                value: "4117",
            },
        ]);
    });

    it("creates synthetic unminted token rows without canonical metadata", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionOnly();
        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher();
        const tokenId = buildTerraformsUnmintedTokenId(42n);
        const tokenUriArgs: unknown[][] = [];
        const rpc = createRpcStub({
            onReadContract({ functionName, args }) {
                if (functionName === "tokenURI") {
                    tokenUriArgs.push([...(args ?? [])]);
                    return buildMetadataDataUri({
                        name: "Unminted Terraforms placement 42",
                        image: "data:image/svg+xml;base64,unminted-42",
                        animation_url:
                            "https://example.com/unminted-42-animation",
                        attributes: [
                            {
                                trait_type: TERRAFORMS_MODE_ATTRIBUTE_KEY,
                                value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                            },
                            {
                                trait_type: TERRAFORMS_ZONE_ATTRIBUTE_KEY,
                                value: "Alto",
                            },
                            {
                                trait_type: TERRAFORMS_BIOME_ATTRIBUTE_KEY,
                                value: "17",
                            },
                        ],
                    });
                }
                if (functionName === "tokenHTML") {
                    return "<html><body>unminted-42</body></html>";
                }
                throw new Error(`Unexpected contract call: ${functionName}`);
            },
        });

        await terraformsIndexerExtension.refreshArtifacts({
            rpc,
            metadataFetcher,
            installs: collectionExtensions,
            artifacts: collectionExtensions,
            attributes: collectionExtensions,
            syntheticTokens: collectionExtensions,
            install: buildInstall(collectionId),
            payload: {
                chainId: 1,
                collectionId,
                contract: TERRAFORMS_ADDRESS,
                tokenId,
                reason: "bootstrap-snapshot",
                source: "bootstrap",
            },
        });

        expect(selectTokenExists(collectionId, tokenId)).toBe(true);
        expect(selectTokenMetadataExists(collectionId, tokenId)).toBe(false);
        expect(tokenUriArgs[0]?.[0]).toBe(42n);
        expect(tokenUriArgs[0]?.[1]).toBe(0n);
        expect(tokenUriArgs[0]?.[2]).toBe(42n);
        expect(
            collectionExtensions.getArtifact({
                chainId: 1,
                collectionId,
                tokenId,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            })?.image,
        ).toBe("data:image/svg+xml;base64,unminted-42");
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId,
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBe(TERRAFORMS_MINTED_ATTRIBUTE_VALUES.False);
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId,
                key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
            }),
        ).toBe(TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain);
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId,
                key: TERRAFORMS_ZONE_ATTRIBUTE_KEY,
            }),
        ).toBe("Alto");
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId,
                key: TERRAFORMS_BIOME_ATTRIBUTE_KEY,
            }),
        ).toBe("17");
    });

    it("retires the matching synthetic row when a real token refreshes", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7712", "Terrain");
        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher();
        const syntheticTokenId = buildTerraformsUnmintedTokenId(42n);
        seedSyntheticUnmintedToken(collectionExtensions, {
            collectionId,
            tokenId: syntheticTokenId,
        });

        const rpc = createRpcStub({
            onReadContract({ functionName }) {
                if (functionName === "tokenToPlacement") {
                    return 42n;
                }
                if (functionName === "tokenURI") {
                    return buildMetadataDataUri({
                        name: "Terrain #7712 v2",
                        image: "data:image/svg+xml;base64,terrain-v2",
                        animation_url:
                            "https://example.com/terrain-v2-animation",
                        attributes: [
                            {
                                trait_type: TERRAFORMS_MODE_ATTRIBUTE_KEY,
                                value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                            },
                        ],
                    });
                }
                if (functionName === "tokenHTML") {
                    return "<html><body>terrain-v2</body></html>";
                }
                throw new Error(`Unexpected contract call: ${functionName}`);
            },
        });

        await terraformsIndexerExtension.refreshArtifacts({
            rpc,
            metadataFetcher,
            installs: collectionExtensions,
            artifacts: collectionExtensions,
            attributes: collectionExtensions,
            syntheticTokens: collectionExtensions,
            install: buildInstall(collectionId),
            payload: {
                chainId: 1,
                collectionId,
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7712",
                reason: "collection-extension",
                source: "onchain",
            },
        });

        expect(selectTokenExists(collectionId, syntheticTokenId)).toBe(false);
        expect(
            collectionExtensions.getArtifact({
                chainId: 1,
                collectionId,
                tokenId: syntheticTokenId,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            }),
        ).toBeNull();
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: syntheticTokenId,
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBeNull();
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7712",
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBe(TERRAFORMS_MINTED_ATTRIBUTE_VALUES.True);
    });

    it("does not recreate a retired synthetic row from a delayed unminted task", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7712", "Terrain");
        const collectionExtensions = new SqliteCollectionExtensions();
        const metadataFetcher = new HttpMetadataFetcher();
        const syntheticTokenId = buildTerraformsUnmintedTokenId(42n);

        await terraformsIndexerExtension.refreshArtifacts({
            rpc: createRpcStub({
                onReadContract({ functionName }) {
                    if (functionName === "tokenToPlacement") {
                        return 42n;
                    }
                    if (functionName === "tokenURI") {
                        return buildMetadataDataUri({
                            name: "Terrain #7712 v2",
                            image: "data:image/svg+xml;base64,terrain-v2",
                            animation_url:
                                "https://example.com/terrain-v2-animation",
                            attributes: [
                                {
                                    trait_type: TERRAFORMS_MODE_ATTRIBUTE_KEY,
                                    value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                                },
                            ],
                        });
                    }
                    if (functionName === "tokenHTML") {
                        return "<html><body>terrain-v2</body></html>";
                    }
                    throw new Error(
                        `Unexpected contract call: ${functionName}`,
                    );
                },
            }),
            metadataFetcher,
            installs: collectionExtensions,
            artifacts: collectionExtensions,
            attributes: collectionExtensions,
            syntheticTokens: collectionExtensions,
            install: buildInstall(collectionId),
            payload: {
                chainId: 1,
                collectionId,
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7712",
                reason: "collection-extension",
                source: "onchain",
            },
        });

        const delayedRefreshResult =
            await terraformsIndexerExtension.refreshArtifacts({
                rpc: createRpcStub({
                    onReadContract({ functionName }) {
                        if (functionName === "tokenURI") {
                            return buildMetadataDataUri({
                                name: "Unminted Terraforms placement 42",
                                image: "data:image/svg+xml;base64,unminted-42",
                                animation_url:
                                    "https://example.com/unminted-42-animation",
                                attributes: [
                                    {
                                        trait_type:
                                            TERRAFORMS_MODE_ATTRIBUTE_KEY,
                                        value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                                    },
                                ],
                            });
                        }
                        if (functionName === "tokenHTML") {
                            return "<html><body>unminted-42</body></html>";
                        }
                        throw new Error(
                            `Unexpected contract call: ${functionName}`,
                        );
                    },
                }),
                metadataFetcher,
                installs: collectionExtensions,
                artifacts: collectionExtensions,
                attributes: collectionExtensions,
                syntheticTokens: collectionExtensions,
                install: buildInstall(collectionId),
                payload: {
                    chainId: 1,
                    collectionId,
                    contract: TERRAFORMS_ADDRESS,
                    tokenId: syntheticTokenId,
                    reason: "bootstrap-snapshot",
                    source: "bootstrap",
                },
            });

        expect(delayedRefreshResult).toEqual({ attributesChanged: false });
        expect(selectTokenExists(collectionId, syntheticTokenId)).toBe(false);
        expect(
            collectionExtensions.getArtifact({
                chainId: 1,
                collectionId,
                tokenId: syntheticTokenId,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            }),
        ).toBeNull();
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7712",
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBe(TERRAFORMS_MINTED_ATTRIBUTE_VALUES.True);
    });

    it("does not leave a bare synthetic token when unminted rendering fails", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionOnly();
        const collectionExtensions = new SqliteCollectionExtensions();
        const tokenId = buildTerraformsUnmintedTokenId(42n);

        await expect(
            terraformsIndexerExtension.refreshArtifacts({
                rpc: createRpcStub({
                    onReadContract({ functionName }) {
                        if (functionName === "tokenURI") {
                            return buildMetadataDataUri({
                                name: "Unminted Terraforms placement 42",
                                image: "data:image/svg+xml;base64,unminted-42",
                                attributes: [],
                            });
                        }
                        if (functionName === "tokenHTML") {
                            return "";
                        }
                        throw new Error(
                            `Unexpected contract call: ${functionName}`,
                        );
                    },
                }),
                metadataFetcher: new HttpMetadataFetcher(),
                installs: collectionExtensions,
                artifacts: collectionExtensions,
                attributes: collectionExtensions,
                syntheticTokens: collectionExtensions,
                install: buildInstall(collectionId),
                payload: {
                    chainId: 1,
                    collectionId,
                    contract: TERRAFORMS_ADDRESS,
                    tokenId,
                    reason: "bootstrap-snapshot",
                    source: "bootstrap",
                },
            }),
        ).rejects.toThrow("Terraforms unminted HTML fetch failed");

        expect(selectTokenExists(collectionId, tokenId)).toBe(false);
        expect(selectTokenMetadataExists(collectionId, tokenId)).toBe(false);
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId,
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBeNull();
    });

    it("keeps the synthetic row when real-token rendering fails before replacement", async () => {
        resetExtensionTables();
        const collectionId = seedCollectionToken("7712", "Terrain");
        const collectionExtensions = new SqliteCollectionExtensions();
        const syntheticTokenId = buildTerraformsUnmintedTokenId(42n);
        seedSyntheticUnmintedToken(collectionExtensions, {
            collectionId,
            tokenId: syntheticTokenId,
        });

        await expect(
            terraformsIndexerExtension.refreshArtifacts({
                rpc: createRpcStub({
                    onReadContract({ functionName }) {
                        if (functionName === "tokenToPlacement") {
                            return 42n;
                        }
                        if (functionName === "tokenURI") {
                            return buildMetadataDataUri({
                                name: "Terrain #7712 v2",
                                image: "data:image/svg+xml;base64,terrain-v2",
                                attributes: [
                                    {
                                        trait_type:
                                            TERRAFORMS_MODE_ATTRIBUTE_KEY,
                                        value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
                                    },
                                ],
                            });
                        }
                        if (functionName === "tokenHTML") {
                            return "";
                        }
                        throw new Error(
                            `Unexpected contract call: ${functionName}`,
                        );
                    },
                }),
                metadataFetcher: new HttpMetadataFetcher(),
                installs: collectionExtensions,
                artifacts: collectionExtensions,
                attributes: collectionExtensions,
                syntheticTokens: collectionExtensions,
                install: buildInstall(collectionId),
                payload: {
                    chainId: 1,
                    collectionId,
                    contract: TERRAFORMS_ADDRESS,
                    tokenId: "7712",
                    reason: "collection-extension",
                    source: "onchain",
                },
            }),
        ).rejects.toThrow("Terraforms v2 HTML fetch failed");

        expect(selectTokenExists(collectionId, syntheticTokenId)).toBe(true);
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: syntheticTokenId,
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBe(TERRAFORMS_MINTED_ATTRIBUTE_VALUES.False);
        expect(
            collectionExtensions.getTokenAttributeValue({
                chainId: 1,
                collectionId,
                tokenId: "7712",
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
            }),
        ).toBeNull();
    });

    it("blocks synthetic retirement when unexpected canonical state exists", () => {
        resetExtensionTables();
        const collectionId = seedCollectionOnly();
        const collectionExtensions = new SqliteCollectionExtensions();
        const tokenId = buildTerraformsUnmintedTokenId(42n);
        seedSyntheticUnmintedToken(collectionExtensions, {
            collectionId,
            tokenId,
        });
        db.prepare(
            "INSERT INTO token_metadata " +
                "(chain_id, collection_id, contract_address, token_id, uri) " +
                "VALUES (?, ?, ?, ?, ?)",
        ).run(
            1,
            collectionId,
            TERRAFORMS_ADDRESS,
            tokenId,
            "data:application/json;base64,canonical",
        );

        const result = collectionExtensions.retireSyntheticToken({
            chainId: 1,
            collectionId,
            contractAddress: TERRAFORMS_ADDRESS,
            tokenId,
            extensionKey: TERRAFORMS_EXTENSION_KEY,
        });

        expect(result).toEqual({
            retired: false,
            blockedByCanonicalState: true,
        });
        expect(selectTokenExists(collectionId, tokenId)).toBe(true);
        expect(selectTokenMetadataExists(collectionId, tokenId)).toBe(true);
    });
});

function buildInstall(collectionId: number) {
    return {
        chainId: 1,
        collectionId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        enabled: true,
        configJson: JSON.stringify({
            mainContractAddress: TERRAFORMS_ADDRESS,
            rendererV2ContractAddress: TERRAFORMS_RENDERER_V2_ADDRESS,
            tokenUriV2ContractAddress: TERRAFORMS_TOKEN_URI_V2_ADDRESS,
            beaconV2ContractAddress: TERRAFORMS_BEACON_V2_ADDRESS,
        }),
        createdAt: "2026-03-08T00:00:00Z",
        updatedAt: "2026-03-08T00:00:00Z",
    };
}

function resetExtensionTables(): void {
    db.exec(
        [
            "DELETE FROM collection_extension_synthetic_token_retirements;",
            "DELETE FROM token_extension_artifacts;",
            "DELETE FROM token_attributes;",
            "DELETE FROM attributes;",
            "DELETE FROM attribute_keys;",
            "DELETE FROM token_metadata;",
            "DELETE FROM tokens;",
            "DELETE FROM collection_extension_installs;",
            "DELETE FROM collections;",
        ].join("\n"),
    );
}

function seedSyntheticUnmintedToken(
    collectionExtensions: SqliteCollectionExtensions,
    input: {
        collectionId: number;
        tokenId: string;
    },
): void {
    const publication = collectionExtensions.publishSyntheticToken({
        chainId: 1,
        collectionId: input.collectionId,
        contractAddress: TERRAFORMS_ADDRESS,
        tokenId: input.tokenId,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        artifact: {
            chainId: 1,
            collectionId: input.collectionId,
            contractAddress: TERRAFORMS_ADDRESS,
            tokenId: input.tokenId,
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media,
            uri: null,
            rawJson: null,
            attributesJson: null,
            image: "data:image/svg+xml;base64,old-unminted",
            animationUrl: null,
            htmlContent: "<html><body>old-unminted</body></html>",
        },
        attributes: [
            {
                key: TERRAFORMS_MINTED_ATTRIBUTE_KEY,
                value: TERRAFORMS_MINTED_ATTRIBUTE_VALUES.False,
            },
        ],
    });

    expect(publication).toEqual({
        published: true,
        blockedByCanonicalState: false,
        blockedByRetirement: false,
    });
}

function selectArtifactDebugColumns(params: {
    collectionId: number;
    tokenId: string;
    artifactRef: string;
}): ArtifactDebugColumnRow | null {
    const row = db
        .prepare(
            "SELECT uri, raw_json, attributes_json " +
                "FROM token_extension_artifacts " +
                "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
                "AND extension_key = ? AND artifact_ref = ? " +
                "LIMIT 1",
        )
        .get(
            1,
            params.collectionId,
            params.tokenId,
            TERRAFORMS_EXTENSION_KEY,
            params.artifactRef,
        ) as ArtifactDebugColumnRow | undefined;

    return row ?? null;
}

function seedCollectionToken(tokenId: string, mode: string): number {
    const collectionId = seedCollectionOnly();

    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (?, ?, ?, ?)",
    ).run(1, collectionId, TERRAFORMS_ADDRESS, tokenId);

    const modeKeyId = Number(
        db
            .prepare(
                "INSERT INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (?, ?, ?, ?)",
            )
            .run(
                1,
                collectionId,
                TERRAFORMS_ADDRESS,
                TERRAFORMS_MODE_ATTRIBUTE_KEY,
            ).lastInsertRowid,
    );
    const attributeId = Number(
        db
            .prepare(
                "INSERT INTO attributes (chain_id, collection_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?, ?)",
            )
            .run(1, collectionId, TERRAFORMS_ADDRESS, modeKeyId, mode)
            .lastInsertRowid,
    );
    db.prepare(
        "INSERT INTO token_attributes " +
            "(chain_id, collection_id, contract_address, token_id, attribute_id, source_kind, source_key) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        collectionId,
        TERRAFORMS_ADDRESS,
        tokenId,
        attributeId,
        TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
        TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    );

    return collectionId;
}

function seedCollectionOnly(): number {
    const collectionId = Number(
        db
            .prepare(
                "INSERT INTO collections " +
                    "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply, deployment_block, created_at, updated_at) " +
                    "VALUES (?, ?, ?, ?, ?, 'contract_all_tokens', NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            )
            .run(1, "terraforms", TERRAFORMS_ADDRESS, "erc721", "live", 1)
            .lastInsertRowid,
    );

    db.prepare(
        "INSERT INTO collection_extension_installs " +
            "(chain_id, collection_id, extension_key, enabled, config_json) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        1,
        collectionId,
        TERRAFORMS_EXTENSION_KEY,
        1,
        buildInstall(collectionId).configJson,
    );

    return collectionId;
}

function selectTokenExists(collectionId: number, tokenId: string): boolean {
    const row = db
        .prepare(
            "SELECT 1 AS present FROM tokens " +
                "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
                "LIMIT 1",
        )
        .get(1, collectionId, tokenId) as { present: number } | undefined;
    return row?.present === 1;
}

function selectTokenMetadataExists(
    collectionId: number,
    tokenId: string,
): boolean {
    const row = db
        .prepare(
            "SELECT 1 AS present FROM token_metadata " +
                "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
                "LIMIT 1",
        )
        .get(1, collectionId, tokenId) as { present: number } | undefined;
    return row?.present === 1;
}

function buildMetadataDataUri(payload: Record<string, unknown>): string {
    return `data:application/json;base64,${Buffer.from(
        JSON.stringify(payload),
        "utf8",
    ).toString("base64")}`;
}

function createRpcStub(input: {
    onReadContract(params: {
        address: string;
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): unknown;
    onGetTransaction?: (txHash: string) => {
        from: `0x${string}`;
    };
}): RpcProviderPort {
    return {
        async getBlockNumber() {
            throw new Error("Unexpected getBlockNumber");
        },
        async getBlock() {
            throw new Error("Unexpected getBlock");
        },
        async getLogs() {
            throw new Error("Unexpected getLogs");
        },
        async getTransaction(txHash) {
            const tx = input.onGetTransaction?.(txHash);
            if (!tx) {
                throw new Error("Unexpected getTransaction");
            }
            return {
                hash: txHash as `0x${string}`,
                from: tx.from,
                to: null,
                input: "0x",
            };
        },
        async getTransactionReceipt() {
            throw new Error("Unexpected getTransactionReceipt");
        },
        async readContract<T = unknown>(params) {
            return input.onReadContract({
                address: params.address,
                functionName: params.functionName,
                args: params.args,
                blockNumber: params.blockNumber,
            }) as T;
        },
        async getBalance() {
            throw new Error("Unexpected getBalance");
        },
    };
}

function unexpectedReadContract(params: {
    address: string;
    functionName: string;
    args?: readonly unknown[];
}): unknown {
    throw new Error(`Unexpected contract call: ${params.functionName}`);
}
