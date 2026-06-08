import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";

export type BootstrapRunDefinition = {
    runId: number;
    chainId: number;
    collectionId: number;
    requestSlug: string;
    requestAddress: string;
    requestStandard: "erc721" | "erc1155";
    requestExtensionKey: CollectionExtensionKey | null;
    metadataMode: "strict" | "best_effort";
    enumerationMode: "enumerable" | "manual_token_ids" | "manual_range";
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
    imageCacheMode: ImageCacheMode;
    imageCacheMaxDimension: number | null;
    deploymentBlock: number | null;
    status: string;
    anchorBlock: number | null;
    anchorBlockHash: string | null;
    anchorBlockTimestamp: number | null;
};

export interface BootstrapRunsPort {
    getRun(runId: number): BootstrapRunDefinition | null;
    updateRunStatus(
        runId: number,
        status: string,
        error?: { code: string; message: string } | null,
    ): void;
    updateRunAnchor(input: {
        runId: number;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }): void;
    appendRunEvent(input: {
        runId: number;
        chainId: number;
        collectionId: number;
        eventCode: string;
        eventLevel: "info" | "warn" | "error";
        message: string;
        payloadJson: string | null;
    }): void;
}
