import { describe, expect, it } from "vitest";
import {
    TERRAFORMS_EVENT_RENDER_MODES,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
} from "@artgod/shared/extensions/terraforms";
import { terraformsBackendCollectionExtension } from "./terraforms.js";
import type {
    BackendCollectionExtensionActivityEventContext,
    BackendCollectionExtensionRenderContext,
} from "./types.js";

const MAIN_CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const RENDERER_V2 = "0x8af860c8f157f4e3b6a54913bfa6bb96ab2605c2";
const TOKEN_URI_V2 = "0xfca647387e28e73e291dd90e7b09fa32bcbb2604";
const BEACON_V2 = "0x331512a28a4cf80221af949b5d43041ff0fc7f01";

describe("terraformsBackendCollectionExtension", () => {
    it("labels the Terraformed activity feed as dreams without changing event identity", () => {
        const [feed] = terraformsBackendCollectionExtension.listActivityEventFeeds(
            buildTerraformsInstall(),
        );

        expect(feed).toMatchObject({
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
            label: "dreams",
        });
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
                throw new Error(`Unexpected contract call: ${params.functionName}`);
            },
            async getStorageAt() {
                throw new Error("Unexpected storage read");
            },
        };

        const token = await terraformsBackendCollectionExtension.resolveActivityEventPreview?.(
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
        const htmlCall = calls.find((call) => call.functionName === "tokenHTML");

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
        expect(statusCall?.blockNumber).toBeUndefined();
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
            canvasRows: Array.from({ length: 16 }, (_, index) =>
                String(index + 1),
            ),
        },
    };
}
