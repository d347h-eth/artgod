import { describe, expect, it } from "vitest";
import {
    COLLECTION_MEDIA_MODE_OPTIONS,
    COLLECTION_MEDIA_MODES,
    COLLECTION_MEDIA_PREFERENCE_VALUES,
    type CollectionMediaPreferenceValue,
} from "@artgod/shared/extensions";
import {
    buildTerraformsUnmintedTokenId,
    TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS,
    TERRAFORMS_CANVAS_ROW_COUNT,
    TERRAFORMS_DECAY_DELAY_SECONDS_PER_DREAMER,
    TERRAFORMS_DECAY_PERIOD_SECONDS,
    TERRAFORMS_DAYDREAM_STATUS,
    TERRAFORMS_EVENT_RENDER_MODES,
    TERRAFORMS_EXTENSION_ARTIFACT_REFS,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX,
    TERRAFORMS_MAIN_READ_FUNCTIONS,
    TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED,
    TERRAFORMS_MEDIA_MODE_OPTIONS,
    TERRAFORMS_MEDIA_MODES,
    TERRAFORMS_MEDIA_VARIANT_OPTIONS,
    TERRAFORMS_MEDIA_VARIANTS,
    TERRAFORMS_ORIGIN_DAYDREAM_STATUS,
    TERRAFORMS_RENDERER_READ_FUNCTIONS,
    TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT,
    TERRAFORMS_TERRAFORMED_STATUS,
    TERRAFORMS_TERRAIN_STATUS,
    TERRAFORMS_TOKEN_TO_CANVAS_DATA_STORAGE_SLOT,
    TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT,
    TERRAFORMS_VERSION_ATTRIBUTE_KEY,
    TERRAFORMS_VERSION_ATTRIBUTE_VALUES,
} from "@artgod/shared/extensions/terraforms";
import { concatHex, keccak256, padHex, toHex } from "viem";
import { terraformsBackendCollectionExtension } from "./terraforms.js";
import type {
    BackendCollectionExtensionActivityEventContext,
    BackendCollectionExtensionRenderContext,
    BackendCollectionExtensionTokenMediaContext,
} from "./types.js";

const MAIN_CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const RENDERER_V2 = "0x8af860c8f157f4e3b6a54913bfa6bb96ab2605c2";
const TOKEN_URI_V2 = "0xfca647387e28e73e291dd90e7b09fa32bcbb2604";
const BEACON_V2 = "0x331512a28a4cf80221af949b5d43041ff0fc7f01";

describe("terraformsBackendCollectionExtension", () => {
    it("labels the Terraformed activity feed as dreams without changing event identity", () => {
        const [feed] =
            terraformsBackendCollectionExtension.listActivityEventFeeds(
                buildTerraformsInstall(),
            );

        expect(feed).toMatchObject({
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
            label: "dreams",
        });
        expect(
            terraformsBackendCollectionExtension.listActivityEventFeeds(
                buildTerraformsInstall(),
            ),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                    eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Beacon,
                    label: "beacon",
                    filters: expect.objectContaining({
                        eventGroup: {
                            label: "type",
                            options: TERRAFORMS_BEACON_EVENT_GROUP_OPTIONS,
                        },
                    }),
                }),
            ]),
        );
    });

    it("exposes live as an extension-provided media mode", () => {
        expect(
            terraformsBackendCollectionExtension.listMediaModes(
                buildTerraformsInstall(),
            ),
        ).toEqual([
            COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
            TERRAFORMS_MEDIA_MODE_OPTIONS.Live,
        ]);
        expect(
            terraformsBackendCollectionExtension.defaultMediaMode(
                buildTerraformsInstall(),
            ),
        ).toBe(COLLECTION_MEDIA_MODES.Snapshot);
    });

    it("uses the extension-owned preference default when selection is omitted or unknown", () => {
        const install = buildTerraformsInstall();
        const resolvePreference = (
            requested?: CollectionMediaPreferenceValue,
        ) =>
            terraformsBackendCollectionExtension.resolveMediaPreference?.(
                install,
                requested,
            );

        expect(resolvePreference()?.enabled).toBe(
            TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED,
        );
        expect(
            resolvePreference("unknown" as CollectionMediaPreferenceValue)
                ?.enabled,
        ).toBe(TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED);
        expect(
            resolvePreference(COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled)
                ?.enabled,
        ).toBe(true);
        expect(
            resolvePreference(COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled)
                ?.enabled,
        ).toBe(false);
    });

    it("keeps canonical V2 visible beside artifacts and changes only default priority", async () => {
        const baseContext = {
            tokenId: "7710",
            requestedMode: COLLECTION_MEDIA_MODES.Snapshot,
            canonical: {
                isCanonicalToken: true,
                animationUrl: "snapshot-animation",
                getAttributeValue(key: string) {
                    return key === TERRAFORMS_VERSION_ATTRIBUTE_KEY
                        ? TERRAFORMS_VERSION_ATTRIBUTE_VALUES.V2
                        : null;
                },
            },
            getArtifact(ref: string) {
                return {
                    extensionKey: TERRAFORMS_EXTENSION_KEY,
                    artifactRef: ref,
                    image: "artifact-image",
                    animationUrl: null,
                    htmlContent: "<html>artifact</html>",
                };
            },
        } satisfies BackendCollectionExtensionTokenMediaContext;
        const preferred =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                {
                    ...baseContext,
                    requestedPreference:
                        COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled,
                },
            );
        const canonical =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                {
                    ...baseContext,
                    requestedPreference:
                        COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
                },
            );

        expect(preferred?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2Artifact,
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2LostTerrain,
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2,
        ]);
        expect(preferred?.selectedVariant).toBe(
            TERRAFORMS_MEDIA_VARIANTS.V2Artifact,
        );
        expect(canonical?.selectedVariant).toBe(TERRAFORMS_MEDIA_VARIANTS.V2);
    });

    it("keeps synthetic artifact-only tokens on snapshot media", async () => {
        const media =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                {
                    tokenId: buildTerraformsUnmintedTokenId(921n),
                    requestedMode: TERRAFORMS_MEDIA_MODES.Live,
                    requestedPreference:
                        COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
                    canonical: {
                        isCanonicalToken: false,
                        animationUrl: "stale-canonical-animation",
                        getAttributeValue(key) {
                            return key === TERRAFORMS_VERSION_ATTRIBUTE_KEY
                                ? TERRAFORMS_VERSION_ATTRIBUTE_VALUES.V2
                                : null;
                        },
                    },
                    getArtifact(ref) {
                        return ref ===
                            TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media ||
                            ref ===
                                TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain
                            ? {
                                  extensionKey: TERRAFORMS_EXTENSION_KEY,
                                  artifactRef: ref,
                                  image: "artifact-image",
                                  animationUrl: null,
                                  htmlContent: "<html>artifact</html>",
                              }
                            : null;
                    },
                },
            );

        expect(media?.availableModes).toEqual([
            COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
        ]);
        expect(media?.selectedMode).toBe(COLLECTION_MEDIA_MODES.Snapshot);
        expect(media?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2Artifact,
        ]);
        expect(media?.selectedVariant).toBe(
            TERRAFORMS_MEDIA_VARIANTS.V2Artifact,
        );
    });

    it("does not auto-select an artifact for canonical snapshot media when preference is disabled", async () => {
        const context = {
            tokenId: "7710",
            requestedPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
            canonical: {
                isCanonicalToken: true,
                animationUrl: null,
                getAttributeValue: () => null,
            },
            getArtifact(ref: string) {
                return ref === TERRAFORMS_EXTENSION_ARTIFACT_REFS.V2Media
                    ? {
                          extensionKey: TERRAFORMS_EXTENSION_KEY,
                          artifactRef: ref,
                          image: "artifact-image",
                          animationUrl: null,
                          htmlContent: "<html>artifact</html>",
                      }
                    : null;
            },
        } satisfies BackendCollectionExtensionTokenMediaContext;
        const media =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                context,
            );
        const explicitArtifact =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                {
                    ...context,
                    requestedVariant: TERRAFORMS_MEDIA_VARIANTS.V2Artifact,
                },
            );

        expect(media?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2Artifact,
        ]);
        expect(media?.defaultVariant).toBeNull();
        expect(media?.selectedVariant).toBeNull();
        expect(explicitArtifact?.selectedVariant).toBe(
            TERRAFORMS_MEDIA_VARIANTS.V2Artifact,
        );
    });

    it("falls back to the available canonical snapshot when artifacts are absent", async () => {
        const canonicalV2 = await resolveCanonicalSnapshotMedia(
            TERRAFORMS_VERSION_ATTRIBUTE_VALUES.V2,
        );
        const canonicalV0 = await resolveCanonicalSnapshotMedia(null);

        expect(canonicalV2?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2,
        ]);
        expect(canonicalV2?.selectedVariant).toBe(TERRAFORMS_MEDIA_VARIANTS.V2);
        expect(canonicalV0?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0,
        ]);
        expect(canonicalV0?.selectedVariant).toBe(TERRAFORMS_MEDIA_VARIANTS.V0);
    });

    it("never auto-selects lost terrain", async () => {
        const media =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                {
                    tokenId: "7710",
                    canonical: {
                        isCanonicalToken: true,
                        animationUrl: null,
                        getAttributeValue: () => null,
                    },
                    getArtifact(ref) {
                        return ref ===
                            TERRAFORMS_EXTENSION_ARTIFACT_REFS.LostTerrain
                            ? {
                                  extensionKey: TERRAFORMS_EXTENSION_KEY,
                                  artifactRef: ref,
                                  image: "lost-image",
                                  animationUrl: null,
                                  htmlContent: "<html>lost</html>",
                              }
                            : null;
                    },
                },
            );

        expect(media?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2LostTerrain,
        ]);
        expect(media?.selectedVariant).toBeNull();
    });

    it("uses the owner-selected live renderer when V2 preference is disabled", async () => {
        const media =
            await terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
                buildTerraformsInstall(),
                {
                    tokenId: "7710",
                    requestedMode: TERRAFORMS_MEDIA_MODES.Live,
                    requestedPreference:
                        COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
                    canonical: {
                        isCanonicalToken: true,
                        animationUrl: "snapshot-animation",
                        getAttributeValue: () => null,
                    },
                    getArtifact: () => null,
                    rpc: {
                        async readContract() {
                            throw new Error("Unexpected contract read");
                        },
                        async getStorageAt(input) {
                            expect(input.blockNumber).toBe(12_345);
                            return "0x01";
                        },
                        async getCurrentBlockNumber() {
                            return 12_345;
                        },
                        async getBlockTimestamp() {
                            throw new Error("Unexpected timestamp read");
                        },
                    },
                },
            );

        expect(media?.selectedVariant).toBe(TERRAFORMS_MEDIA_VARIANTS.V1);
        expect(media?.defaultVariant).toBe(TERRAFORMS_MEDIA_VARIANTS.V1);
        expect(media?.availableVariants).toEqual([
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2,
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V1,
            TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0,
        ]);
    });

    it("renders fresh zero-length canvases without reading nonexistent rows", async () => {
        for (const status of [
            TERRAFORMS_TERRAIN_STATUS,
            TERRAFORMS_DAYDREAM_STATUS,
            TERRAFORMS_ORIGIN_DAYDREAM_STATUS,
        ]) {
            const rpc = createLiveRpc({
                currentRendererIndex:
                    TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                        TERRAFORMS_MEDIA_VARIANTS.V2
                    ],
                status,
                canvasLength: 0n,
            });
            const token =
                await terraformsBackendCollectionExtension.resolveTokenPreview(
                    buildTerraformsInstall(),
                    tokenPreview(),
                    {
                        mediaMode: TERRAFORMS_MEDIA_MODES.Live,
                        mediaVariant: TERRAFORMS_MEDIA_VARIANTS.V1,
                        artifact: null,
                        rpc,
                    },
                );

            const rendererCall = rpc.calls.find(
                (call) =>
                    call.functionName ===
                        TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml &&
                    call.address !== MAIN_CONTRACT,
            );
            expect(rendererCall?.address).toBe(
                TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX[
                    TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                        TERRAFORMS_MEDIA_VARIANTS.V1
                    ].toString()
                ],
            );
            expect(rendererCall?.args?.[0]).toBe(status);
            expect(rendererCall?.args?.[2]).toBe(42_424n);
            expect(rendererCall?.args?.[4]).toEqual([]);
            expect(
                rpc.calls.some(
                    (call) =>
                        call.functionName ===
                        TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData,
                ),
            ).toBe(false);
            expect(rpc.calls.every((call) => call.blockNumber === 12_345)).toBe(
                true,
            );
            expect(token.animationUrl).toMatch(/^data:text\/html;base64,/);
        }
    });

    it("renders retained canvases after tokens re-enter either Daydream state", async () => {
        for (const status of [
            TERRAFORMS_DAYDREAM_STATUS,
            TERRAFORMS_ORIGIN_DAYDREAM_STATUS,
        ]) {
            const rpc = createLiveRpc({
                currentRendererIndex:
                    TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                        TERRAFORMS_MEDIA_VARIANTS.V2
                    ],
                status,
                canvasLength: BigInt(TERRAFORMS_CANVAS_ROW_COUNT),
            });
            await terraformsBackendCollectionExtension.resolveTokenPreview(
                buildTerraformsInstall(),
                tokenPreview(),
                {
                    mediaMode: TERRAFORMS_MEDIA_MODES.Live,
                    mediaVariant: TERRAFORMS_MEDIA_VARIANTS.V1,
                    artifact: null,
                    rpc,
                },
            );

            const rendererCall = rpc.calls.find(
                (call) =>
                    call.functionName ===
                        TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml &&
                    call.address !== MAIN_CONTRACT,
            );
            expect(rendererCall?.args?.[4]).toEqual(
                Array.from({ length: TERRAFORMS_CANVAS_ROW_COUNT }, (_, row) =>
                    BigInt(row + 1),
                ),
            );
            expect(
                rpc.calls.filter(
                    (call) =>
                        call.functionName ===
                        TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData,
                ),
            ).toHaveLength(TERRAFORMS_CANVAS_ROW_COUNT);
        }
    });

    it("renders explicit V2 committed media from pinned canvas state", async () => {
        const rpc = createLiveRpc({
            currentRendererIndex:
                TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                    TERRAFORMS_MEDIA_VARIANTS.V0
                ],
            status: TERRAFORMS_TERRAFORMED_STATUS,
            canvasLength: BigInt(TERRAFORMS_CANVAS_ROW_COUNT),
        });
        await terraformsBackendCollectionExtension.resolveTokenPreview(
            buildTerraformsInstall(),
            tokenPreview(),
            {
                mediaMode: TERRAFORMS_MEDIA_MODES.Live,
                mediaVariant: TERRAFORMS_MEDIA_VARIANTS.V2,
                artifact: null,
                rpc,
            },
        );

        const rendererCall = rpc.calls.find(
            (call) =>
                call.functionName ===
                    TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml &&
                call.address !== MAIN_CONTRACT,
        );
        expect(rendererCall?.address).toBe(
            TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX[
                TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                    TERRAFORMS_MEDIA_VARIANTS.V2
                ].toString()
            ],
        );
        expect(rendererCall?.args?.[4]).toHaveLength(
            TERRAFORMS_CANVAS_ROW_COUNT,
        );
        expect(
            rpc.calls.filter(
                (call) =>
                    call.functionName ===
                    TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData,
            ),
        ).toHaveLength(TERRAFORMS_CANVAS_ROW_COUNT);
        expect(rpc.calls.every((call) => call.blockNumber === 12_345)).toBe(
            true,
        );
    });

    it("computes pinned V0 decay before calling the original renderer", async () => {
        const rpc = createLiveRpc({
            currentRendererIndex:
                TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                    TERRAFORMS_MEDIA_VARIANTS.V2
                ],
            status: TERRAFORMS_TERRAFORMED_STATUS,
            canvasLength: BigInt(TERRAFORMS_CANVAS_ROW_COUNT),
        });
        await terraformsBackendCollectionExtension.resolveTokenPreview(
            buildTerraformsInstall(),
            tokenPreview(),
            {
                mediaMode: TERRAFORMS_MEDIA_MODES.Live,
                mediaVariant: TERRAFORMS_MEDIA_VARIANTS.V0,
                artifact: null,
                rpc,
            },
        );

        const rendererCall = rpc.calls.find(
            (call) =>
                call.functionName ===
                    TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml &&
                call.address !== MAIN_CONTRACT,
        );
        expect(rendererCall?.address).toBe(
            TERRAFORMS_KNOWN_TOKEN_URI_ADDRESSES_BY_INDEX[
                TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                    TERRAFORMS_MEDIA_VARIANTS.V0
                ].toString()
            ],
        );
        expect(rendererCall?.args?.[3]).toBe(2n);
        expect(rpc.blockTimestampRequests).toEqual([12_345]);
    });

    it("fails closed when a committed canvas row cannot be read", async () => {
        const rpc = createLiveRpc({
            currentRendererIndex:
                TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                    TERRAFORMS_MEDIA_VARIANTS.V2
                ],
            status: TERRAFORMS_TERRAFORMED_STATUS,
            canvasLength: BigInt(TERRAFORMS_CANVAS_ROW_COUNT),
            canvasFailureRow: 7n,
        });

        await expect(
            terraformsBackendCollectionExtension.resolveTokenPreview(
                buildTerraformsInstall(),
                tokenPreview(),
                {
                    mediaMode: TERRAFORMS_MEDIA_MODES.Live,
                    mediaVariant: TERRAFORMS_MEDIA_VARIANTS.V1,
                    artifact: null,
                    rpc,
                },
            ),
        ).rejects.toThrow("Canvas row 7 unavailable");
        expect(rpc.calls.every((call) => call.blockNumber === 12_345)).toBe(
            true,
        );
    });

    it("fails closed when the retained canvas has an unexpected row count", async () => {
        const unexpectedRowCount = 8n;
        const rpc = createLiveRpc({
            currentRendererIndex:
                TERRAFORMS_RENDERER_INDEX_BY_MEDIA_VARIANT[
                    TERRAFORMS_MEDIA_VARIANTS.V2
                ],
            status: TERRAFORMS_DAYDREAM_STATUS,
            canvasLength: unexpectedRowCount,
        });

        await expect(
            terraformsBackendCollectionExtension.resolveTokenPreview(
                buildTerraformsInstall(),
                tokenPreview(),
                {
                    mediaMode: TERRAFORMS_MEDIA_MODES.Live,
                    mediaVariant: TERRAFORMS_MEDIA_VARIANTS.V1,
                    artifact: null,
                    rpc,
                },
            ),
        ).rejects.toThrow(
            `Unexpected Terraforms canvas row count: ${unexpectedRowCount}; expected ${TERRAFORMS_CANVAS_ROW_COUNT}`,
        );
        expect(
            rpc.calls.some(
                (call) =>
                    call.functionName ===
                    TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData,
            ),
        ).toBe(false);
    });

    it("renders Terraformed activity previews through tokenHTML without fetching SVG", async () => {
        const calls: Array<{
            address: string;
            functionName: string;
            args?: readonly unknown[];
            blockNumber?: number;
        }> = [];
        const rpc: BackendCollectionExtensionRenderContext["rpc"] = {
            async readContract<T = unknown>(params: {
                address: `0x${string}`;
                abi: readonly unknown[];
                functionName: string;
                args?: readonly unknown[];
                blockNumber?: number;
            }): Promise<T> {
                calls.push({
                    address: params.address,
                    functionName: params.functionName,
                    args: params.args,
                    blockNumber: params.blockNumber,
                });

                if (params.functionName === "tokenToPlacement") return 42n as T;
                if (params.functionName === "tokenToStatus") return 3n as T;
                if (params.functionName === "tokenHTML") {
                    return "<html>event</html>" as T;
                }
                throw new Error(
                    `Unexpected contract call: ${params.functionName}`,
                );
            },
            async getStorageAt() {
                throw new Error("Unexpected storage read");
            },
            async getCurrentBlockNumber() {
                throw new Error("Unexpected current block read");
            },
            async getBlockTimestamp() {
                throw new Error("Unexpected block timestamp read");
            },
        };

        const token =
            await terraformsBackendCollectionExtension.resolveActivityEventPreview?.(
                buildTerraformsInstall(),
                buildTerraformedEventContext(),
                {
                    renderMode: TERRAFORMS_EVENT_RENDER_MODES.Artifact,
                    rpc,
                },
            );

        const placementCall = calls.find(
            (call) => call.functionName === "tokenToPlacement",
        );
        const statusCall = calls.find(
            (call) => call.functionName === "tokenToStatus",
        );
        const htmlCall = calls.find(
            (call) => call.functionName === "tokenHTML",
        );

        expect(token).toMatchObject({
            tokenId: "7710",
            image: null,
        });
        expect(token?.animationUrl).toMatch(/^data:text\/html;base64,/);
        expect(
            Buffer.from(token!.animationUrl!.split(",")[1]!, "base64").toString(
                "utf8",
            ),
        ).toBe("<html>event</html>");
        expect(placementCall?.blockNumber).toBe(22_010_001);
        expect(statusCall?.blockNumber).toBe(22_010_001);
        expect(htmlCall?.address).toBe(RENDERER_V2);
        expect(htmlCall?.args?.[0]).toBe(4n);
        expect(calls.some((call) => call.functionName === "tokenSVG")).toBe(
            false,
        );
    });
});

function buildTerraformsInstall() {
    return {
        chainId: 1,
        collectionId: 7,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        enabled: true,
        configJson: JSON.stringify({
            mainContractAddress: MAIN_CONTRACT,
            rendererV2ContractAddress: RENDERER_V2,
            tokenUriV2ContractAddress: TOKEN_URI_V2,
            beaconV2ContractAddress: BEACON_V2,
        }),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
    };
}

function resolveCanonicalSnapshotMedia(version: string | null) {
    return terraformsBackendCollectionExtension.resolveTokenMediaPresentation?.(
        buildTerraformsInstall(),
        {
            tokenId: "7710",
            canonical: {
                isCanonicalToken: true,
                animationUrl: "snapshot-animation",
                getAttributeValue(key) {
                    return key === TERRAFORMS_VERSION_ATTRIBUTE_KEY
                        ? version
                        : null;
                },
            },
            getArtifact: () => null,
        },
    );
}

function tokenPreview() {
    return {
        tokenId: "7710",
        image: "canonical-image",
        animationUrl: "snapshot-animation",
    };
}

function createLiveRpc(params: {
    currentRendererIndex: bigint;
    status: bigint;
    canvasLength: bigint;
    canvasFailureRow?: bigint;
}) {
    const calls: Array<{
        address: string;
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }> = [];
    const blockTimestampRequests: number[] = [];
    const revealTimestamp = 1_000n;
    const delay = TERRAFORMS_DECAY_DELAY_SECONDS_PER_DREAMER;
    const period = TERRAFORMS_DECAY_PERIOD_SECONDS;
    return {
        calls,
        blockTimestampRequests,
        async readContract<T = unknown>(input: {
            address: `0x${string}`;
            abi: readonly unknown[];
            functionName: string;
            args?: readonly unknown[];
            blockNumber?: number;
        }): Promise<T> {
            calls.push({
                address: input.address,
                functionName: input.functionName,
                args: input.args,
                blockNumber: input.blockNumber,
            });
            if (
                input.functionName ===
                TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToPlacement
            ) {
                return 42n as T;
            }
            if (
                input.functionName ===
                TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToStatus
            ) {
                return params.status as T;
            }
            if (
                input.functionName ===
                TERRAFORMS_MAIN_READ_FUNCTIONS.TokenToCanvasData
            ) {
                const row = BigInt(input.args?.[1] as bigint);
                if (row === params.canvasFailureRow) {
                    throw new Error(`Canvas row ${row} unavailable`);
                }
                return (row + 1n) as T;
            }
            if (input.functionName === TERRAFORMS_MAIN_READ_FUNCTIONS.Seed) {
                return 42_424n as T;
            }
            if (
                input.functionName === TERRAFORMS_MAIN_READ_FUNCTIONS.Dreamers
            ) {
                return 1n as T;
            }
            if (
                input.functionName ===
                TERRAFORMS_MAIN_READ_FUNCTIONS.RevealTimestamp
            ) {
                return revealTimestamp as T;
            }
            if (
                input.functionName ===
                    TERRAFORMS_RENDERER_READ_FUNCTIONS.TokenHtml ||
                input.functionName === TERRAFORMS_MAIN_READ_FUNCTIONS.TokenHtml
            ) {
                return "<html>live</html>" as T;
            }
            throw new Error(`Unexpected contract call: ${input.functionName}`);
        },
        async getStorageAt(input: {
            address: `0x${string}`;
            slot: `0x${string}`;
            blockNumber?: number;
        }) {
            expect(input.blockNumber).toBe(12_345);
            const rendererIndexSlot = resolveTestTokenMappingSlot(
                7710n,
                TERRAFORMS_TOKEN_TO_URI_ADDRESS_INDEX_STORAGE_SLOT,
            );
            if (input.slot === rendererIndexSlot) {
                return toHex(params.currentRendererIndex, {
                    size: 32,
                });
            }
            const canvasLengthSlot = resolveTestTokenMappingSlot(
                7710n,
                TERRAFORMS_TOKEN_TO_CANVAS_DATA_STORAGE_SLOT,
            );
            if (input.slot === canvasLengthSlot) {
                return toHex(params.canvasLength, { size: 32 });
            }
            throw new Error(`Unexpected storage slot: ${input.slot}`);
        },
        async getCurrentBlockNumber() {
            return 12_345;
        },
        async getBlockTimestamp(blockNumber: number) {
            blockTimestampRequests.push(blockNumber);
            return Number(revealTimestamp + delay + 2n * period);
        },
    };
}

function resolveTestTokenMappingSlot(
    tokenId: bigint,
    mappingStorageSlot: bigint,
): `0x${string}` {
    return keccak256(
        concatHex([
            padHex(toHex(tokenId), { size: 32 }),
            padHex(toHex(mappingStorageSlot), { size: 32 }),
        ]),
    );
}

function buildTerraformedEventContext(): BackendCollectionExtensionActivityEventContext {
    return {
        activityId: 33,
        chainId: 1,
        collectionId: 7,
        contract: MAIN_CONTRACT,
        tokenId: "7710",
        blockNumber: 22_010_001,
        txHash: `0x${"11".repeat(32)}`,
        logIndex: 8,
        payload: {
            eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
            canvasRows: Array.from(
                { length: TERRAFORMS_CANVAS_ROW_COUNT },
                (_, index) => String(index + 1),
            ),
        },
    };
}
