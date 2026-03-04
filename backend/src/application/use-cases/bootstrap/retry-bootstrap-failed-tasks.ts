import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import {
    BootstrapConflictError,
    BootstrapValidationError,
} from "./types.js";
import type {
    BootstrapCommandQueuePort,
    BootstrapRunsWritePort,
    ChainRefResolverPort,
} from "./ports.js";

export type RetryBootstrapFailedTasksInput = {
    chainRef: string;
    collectionRef: string;
};

export type RetryBootstrapFailedTasksOutput = {
    runId: number;
    updatedCount: number;
    status: string;
};

export class RetryBootstrapFailedTasksUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
        private readonly bootstrapQueuePort: BootstrapCommandQueuePort,
    ) {}

    async retryFailedTasks(
        input: RetryBootstrapFailedTasksInput,
    ): Promise<RetryBootstrapFailedTasksOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.bootstrapRunsPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        if (!collection) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }
        const latestRun = this.bootstrapRunsPort.getLatestRun(
            chain.publicChainId,
            collection.collectionId,
        );
        if (!latestRun) {
            throw new ReadModelNotFoundError("No bootstrap run for collection");
        }
        if (
            latestRun.anchorBlock === null ||
            !latestRun.anchorBlockHash ||
            latestRun.anchorBlockTimestamp === null
        ) {
            throw new BootstrapValidationError(
                "Run anchor data is incomplete; restart bootstrap",
            );
        }
        if (latestRun.status === "failed") {
            throw new BootstrapConflictError(
                "Run failed fatally; restart bootstrap",
            );
        }
        const updatedCount = this.bootstrapRunsPort.retryFailedTasks(
            latestRun.runId,
        );
        if (updatedCount <= 0) {
            return {
                runId: latestRun.runId,
                updatedCount: 0,
                status: latestRun.status,
            };
        }
        this.bootstrapRunsPort.updateRunStatus(latestRun.runId, "metadata");
        this.bootstrapRunsPort.appendRunEvent({
            runId: latestRun.runId,
            chainId: latestRun.chainId,
            collectionId: latestRun.collectionId,
            eventCode: "metadata.retry.failed_terminal",
            eventLevel: "info",
            message: "Failed metadata tasks moved back to retry",
            payloadJson: JSON.stringify({ updatedCount }),
        });

        await this.bootstrapQueuePort.publishBootstrapMetadataProcess({
            chainId: latestRun.chainId,
            runId: latestRun.runId,
            collectionId: latestRun.collectionId,
            address: latestRun.requestAddress,
            standard: latestRun.requestStandard,
            metadataMode: latestRun.metadataMode,
            anchorBlock: latestRun.anchorBlock,
            anchorHash: latestRun.anchorBlockHash,
            anchorTimestamp: latestRun.anchorBlockTimestamp,
        });

        return {
            runId: latestRun.runId,
            updatedCount,
            status: "metadata",
        };
    }
}
