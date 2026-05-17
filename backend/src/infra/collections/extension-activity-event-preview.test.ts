import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import { ACTIVITY_SOURCE_KIND } from "@artgod/shared/types";
import {
    TERRAFORMS_EVENT_RENDER_MODES,
    TERRAFORMS_EXTENSION_EVENT_KEYS,
    TERRAFORMS_EXTENSION_KEY,
} from "@artgod/shared/extensions/terraforms";
import type { BackendCollectionExtensionRenderContext } from "../../application/collection-extensions/types.js";
import { ExtensionActivityEventPreviewRead } from "./extension-activity-event-preview.js";

const MAIN_CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const RENDERER_V2 = "0x8af860c8f157f4e3b6a54913bfa6bb96ab2605c2";
const TOKEN_URI_V2 = "0xfca647387e28e73e291dd90e7b09fa32bcbb2604";
const BEACON_V2 = "0x331512a28a4cf80221af949b5d43041ff0fc7f01";

class CapturingApm implements ApmPort {
    readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T {
        this.spans.push({ name, attributes });
        return run();
    }
}

describe("ExtensionActivityEventPreviewRead observability", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-extension-preview-"));
        setDbPath(join(tempDir, "test.sqlite"));
        db.exec(
            "CREATE TABLE activities (" +
                "id INTEGER PRIMARY KEY, " +
                "chain_id INTEGER NOT NULL, " +
                "collection_id INTEGER NOT NULL, " +
                "contract_address TEXT NOT NULL, " +
                "token_id TEXT, " +
                "block_number INTEGER, " +
                "tx_hash TEXT, " +
                "log_index INTEGER, " +
                "source_kind TEXT NOT NULL, " +
                "source_name TEXT NOT NULL, " +
                "payload_json TEXT" +
                ")",
        );
        insertTerraformedActivity();
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-extension-preview-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("wraps extension activity preview lookup, mode resolution, and render", async () => {
        const apm = new CapturingApm();
        const previewRead = new ExtensionActivityEventPreviewRead(
            {
                getInstallByCollectionId() {
                    return buildTerraformsInstall();
                },
            },
            buildRpc(),
            apm,
        );

        const preview = await previewRead.getActivityEventPreview({
            chainId: 1,
            collectionId: 7,
            activityId: 33,
            renderMode: TERRAFORMS_EVENT_RENDER_MODES.Artifact,
        });

        expect(preview.media.selectedMode).toBe(
            TERRAFORMS_EVENT_RENDER_MODES.Artifact,
        );
        expect(preview.token.animationUrl).toMatch(/^data:text\/html;base64,/);
        expect(apm.spans.map((span) => span.name)).toEqual([
            "backend.extension.activity_event_preview.db_activity",
            "backend.extension.activity_event_preview.install_lookup",
            "backend.extension.activity_event_preview.modes",
            "backend.extension.activity_event_preview.resolve",
        ]);
        expect(apm.spans[3]?.attributes).toMatchObject({
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: 1,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: 7,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityId]: 33,
            [ARTGOD_SPAN_ATTRIBUTE.ExtensionKey]: TERRAFORMS_EXTENSION_KEY,
            [ARTGOD_SPAN_ATTRIBUTE.ExtensionEventKey]:
                TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
            [ARTGOD_SPAN_ATTRIBUTE.ActivityRenderMode]:
                TERRAFORMS_EVENT_RENDER_MODES.Artifact,
        });
    });
});

function insertTerraformedActivity(): void {
    db.prepare(
        "INSERT INTO activities " +
            "(id, chain_id, collection_id, contract_address, token_id, block_number, tx_hash, log_index, source_kind, source_name, payload_json) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        33,
        1,
        7,
        MAIN_CONTRACT,
        "7710",
        22_010_001,
        `0x${"11".repeat(32)}`,
        8,
        ACTIVITY_SOURCE_KIND.Extension,
        TERRAFORMS_EXTENSION_KEY,
        JSON.stringify({
            eventKey: TERRAFORMS_EXTENSION_EVENT_KEYS.Terraformed,
            canvasRows: Array.from({ length: 16 }, (_, index) =>
                String(index + 1),
            ),
        }),
    );
}

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

function buildRpc(): BackendCollectionExtensionRenderContext["rpc"] {
    return {
        async readContract<T = unknown>(params: {
            functionName: string;
        }): Promise<T> {
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
}
