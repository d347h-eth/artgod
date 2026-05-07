import { db } from "@artgod/shared/database";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type {
    CollectionExtensionInstall,
    CollectionMediaModeOption,
} from "@artgod/shared/extensions";
import { ACTIVITY_SOURCE_KIND } from "@artgod/shared/types";
import type {
    BackendCollectionExtensionActivityEventContext,
    BackendCollectionExtensionRenderContext,
} from "../../application/collection-extensions/types.js";
import { resolveBackendCollectionExtension } from "../../application/collection-extensions/index.js";
import type { GetActivityEventPreviewOutput } from "../../application/use-cases/activities/get-activity-event-preview.js";

type ActivityEventRow = {
    id: number;
    chain_id: number;
    collection_id: number;
    contract_address: string;
    token_id: string | null;
    block_number: number | null;
    tx_hash: string | null;
    log_index: number | null;
    source_kind: string;
    source_name: string;
    payload_json: string | null;
};

type CollectionExtensionRecordsPort = {
    getInstallByCollectionId(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null;
};

export class ExtensionActivityEventPreviewRead {
    private selectActivity = db.prepare<{
        chainId: number;
        collectionId: number;
        activityId: number;
    }>(
        "SELECT id, chain_id, collection_id, contract_address, token_id, block_number, tx_hash, log_index, source_kind, source_name, payload_json " +
            "FROM activities WHERE chain_id = @chainId AND collection_id = @collectionId AND id = @activityId LIMIT 1",
    );

    constructor(
        private readonly extensionRecords: CollectionExtensionRecordsPort,
        private readonly rpc: BackendCollectionExtensionRenderContext["rpc"],
    ) {}

    async getActivityEventPreview(params: {
        chainId: number;
        collectionId: number;
        activityId: number;
        renderMode?: string;
    }): Promise<GetActivityEventPreviewOutput> {
        const row = this.selectActivity.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            activityId: params.activityId,
        }) as ActivityEventRow | undefined;
        if (!row || !row.token_id) {
            throw new ReadModelNotFoundError("Activity event not found");
        }

        const install = this.extensionRecords.getInstallByCollectionId(
            params.chainId,
            params.collectionId,
        );
        const extension = install?.enabled
            ? resolveBackendCollectionExtension(install)
            : null;
        if (
            !install ||
            !extension?.resolveActivityEventPreview ||
            row.source_kind !== ACTIVITY_SOURCE_KIND.Extension ||
            row.source_name !== install.extensionKey
        ) {
            throw new ReadModelNotFoundError("Activity event preview not found");
        }

        const event = mapActivityRow(row);
        const availableModes =
            extension.listActivityEventPreviewModes?.(install, event) ?? [];
        if (availableModes.length === 0) {
            throw new ReadModelNotFoundError("Activity event preview not found");
        }
        const defaultMode =
            extension.defaultActivityEventPreviewMode?.(install, event) ??
            availableModes[0]!.key;
        const selectedMode = normalizeRenderMode(
            params.renderMode,
            availableModes,
            defaultMode,
        );
        const token = await extension.resolveActivityEventPreview(
            install,
            event,
            {
                renderMode: selectedMode,
                rpc: this.rpc,
            },
        );
        if (!token) {
            throw new ReadModelNotFoundError("Activity event preview not found");
        }

        return {
            media: {
                selectedMode,
                defaultMode,
                availableModes,
            },
            token,
        };
    }
}

function mapActivityRow(
    row: ActivityEventRow,
): BackendCollectionExtensionActivityEventContext {
    return {
        activityId: row.id,
        chainId: row.chain_id,
        collectionId: row.collection_id,
        contract: row.contract_address.toLowerCase(),
        tokenId: row.token_id ?? "",
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        logIndex: row.log_index,
        payload: parsePayload(row.payload_json),
    };
}

function parsePayload(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function normalizeRenderMode(
    value: string | undefined,
    availableModes: CollectionMediaModeOption[],
    defaultMode: string,
): string {
    if (value && availableModes.some((mode) => mode.key === value)) {
        return value;
    }
    return defaultMode;
}
