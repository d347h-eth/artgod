import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import type { ImageCacheMode } from "@artgod/shared/media/token-image-cache";
import type {
    BootstrapEnumerationMode,
    BootstrapMetadataMode,
    BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";

export type BootstrapRunDefinition = {
    runId: number;
    chainId: number;
    collectionId: number;
    requestSlug: string;
    requestAddress: string;
    requestStandard: "erc721" | "erc1155";
    imageSourceField: string | null;
    requestExtensionKey: CollectionExtensionKey | null;
    metadataMode: BootstrapMetadataMode;
    enumerationMode: BootstrapEnumerationMode;
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
    imageCacheMode: ImageCacheMode;
    imageCacheMaxDimension: number | null;
    deploymentBlock: number | null;
    status: BootstrapRunStatus;
    anchorBlock: number | null;
    anchorBlockHash: string | null;
    anchorBlockTimestamp: number | null;
};

export interface BootstrapRunsPort {
    getRun(runId: number): BootstrapRunDefinition | null;
    listRunsForStartupSweep(
        chainId: number,
        limit: number,
    ): BootstrapRunDefinition[];
    updateRunStatus(
        runId: number,
        status: BootstrapRunStatus,
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
