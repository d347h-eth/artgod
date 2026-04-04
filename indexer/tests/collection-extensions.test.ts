import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import {
    COLLECTION_EXTENSION_KEYS,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
} from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { terraformsIndexerExtension } from "../src/application/collection-extensions/terraforms.js";
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
    it("decodes sync watch logs into token metadata refresh triggers", () => {
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

        const decoded = specs[0]!.decode({
            address: TERRAFORMS_ADDRESS as `0x${string}`,
            topics: [daydreamingTopic],
            data: encodeAbiParameters([{ type: "uint256" }], [7710n]),
            blockNumber: 101,
            blockHash: `0x${"11".repeat(32)}`,
            transactionHash: `0x${"22".repeat(32)}`,
            logIndex: 3,
        });

        expect(decoded.metadataRefreshEvents).toEqual([
            expect.objectContaining({
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7710",
                reason: "collection-extension",
                trigger: "terraforms.extension-event",
            }),
        ]);
        expect(decoded.metadataRefreshRangeEvents).toEqual([]);
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
                if (functionName === "seed") {
                    return 10196n;
                }
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

        await terraformsIndexerExtension.refreshArtifacts({
            rpc,
            metadataFetcher,
            installs: collectionExtensions,
            artifacts: collectionExtensions,
            install: buildInstall(collectionId),
            payload: {
                chainId: 1,
                collectionId,
                contract: TERRAFORMS_ADDRESS,
                tokenId: "7710",
                reason: "bootstrap-snapshot",
                source: "bootstrap",
            },
        });

        const artifact = collectionExtensions.getArtifact({
            chainId: 1,
            collectionId,
            tokenId: "7710",
            extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
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
        const lostArtifact = collectionExtensions.getArtifact({
            chainId: 1,
            collectionId,
            tokenId: "7710",
            extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
            artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
        });
        expect(lostArtifact?.image).toBe(
            "data:image/svg+xml;base64,terraform-lost",
        );
        expect(lostArtifact?.htmlContent).toBe(
            "<html><body>terraform-lost</body></html>",
        );
        expect(canvasReads).toHaveLength(16);
        expect(tokenUriArgs[0]?.[1]).toBe(2n);
        expect(tokenUriArgs[1]?.[1]).toBe(0n);
        expect(tokenHtmlArgs[0]?.[0]).toBe(2n);
        expect(tokenHtmlArgs[1]?.[0]).toBe(0n);
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
                if (functionName === "seed") {
                    return 10196n;
                }
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
            extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
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
                if (functionName === "seed") {
                    return 10196n;
                }
                if (functionName === "tokenToPlacement") {
                    return 88n;
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
                extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
                artifactRef: TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain,
            }),
        ).toBeNull();
    });
});

function buildInstall(collectionId: number) {
    return {
        chainId: 1,
        collectionId,
        extensionKey: COLLECTION_EXTENSION_KEYS.Terraforms,
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

function seedCollectionToken(tokenId: string, mode: string): number {
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
        COLLECTION_EXTENSION_KEYS.Terraforms,
        1,
        buildInstall(collectionId).configJson,
    );

    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (?, ?, ?, ?)",
    ).run(1, collectionId, TERRAFORMS_ADDRESS, tokenId);

    const modeKeyId = Number(
        db
            .prepare(
                "INSERT INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (?, ?, ?, ?)",
            )
            .run(1, collectionId, TERRAFORMS_ADDRESS, "Mode").lastInsertRowid,
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
        "INSERT INTO token_attributes (chain_id, collection_id, contract_address, token_id, attribute_id) VALUES (?, ?, ?, ?, ?)",
    ).run(1, collectionId, TERRAFORMS_ADDRESS, tokenId, attributeId);

    return collectionId;
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
    }): unknown;
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
        async getTransaction() {
            throw new Error("Unexpected getTransaction");
        },
        async getTransactionReceipt() {
            throw new Error("Unexpected getTransactionReceipt");
        },
        async readContract<T = unknown>(params) {
            return input.onReadContract({
                address: params.address,
                functionName: params.functionName,
                args: params.args,
            }) as T;
        },
        async getBalance() {
            throw new Error("Unexpected getBalance");
        },
    };
}
