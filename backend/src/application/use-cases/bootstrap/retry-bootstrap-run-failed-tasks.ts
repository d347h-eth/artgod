import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_RUN_STATUS,
    type BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";
import { BootstrapConflictError, BootstrapValidationError } from "./types.js";
import type {
    BootstrapCommandQueuePort,
    BootstrapRunsWritePort,
    ChainRefResolverPort,
} from "./ports.js";

export type RetryBootstrapRunFailedTasksInput = {
    chainRef: string;
    runId: number;
};

export type RetryBootstrapRunFailedTasksOutput = {
    runId: number;
    updatedCount: number;
    status: BootstrapRunStatus;
};

export class RetryBootstrapRunFailedTasksUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
        private readonly bootstrapQueuePort: BootstrapCommandQueuePort,
    ) {}

    async retryFailedTasks(
        input: RetryBootstrapRunFailedTasksInput,
    ): Promise<RetryBootstrapRunFailedTasksOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const run = this.bootstrapRunsPort.getRunById(
            chain.publicChainId,
            input.runId,
        );
        if (!run) {
            throw new ReadModelNotFoundError("Unknown bootstrap run");
        }
        if (
            !this.bootstrapRunsPort.isLatestRunForCollection(
                chain.publicChainId,
                run.collectionId,
                run.runId,
            )
        ) {
            throw new BootstrapConflictError(
                "Only latest collection run can retry failed tasks",
            );
        }
        if (
            run.anchorBlock === null ||
            !run.anchorBlockHash ||
            run.anchorBlockTimestamp === null
        ) {
            throw new BootstrapValidationError(
                "Run anchor data is incomplete; queue new bootstrap run",
            );
        }
        if (run.status === BOOTSTRAP_RUN_STATUS.Failed) {
            throw new BootstrapConflictError(
                "Run failed fatally; queue a new bootstrap run",
            );
        }
        const updatedCount = this.bootstrapRunsPort.retryFailedTasks(run.runId);
        if (updatedCount <= 0) {
            return {
                runId: run.runId,
                updatedCount: 0,
                status: run.status,
            };
        }

        this.bootstrapRunsPort.updateRunStatus(
            run.runId,
            BOOTSTRAP_RUN_STATUS.Metadata,
        );
        this.bootstrapRunsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataRetryFailedTerminal,
            eventLevel: "info",
            message: "Failed metadata tasks moved back to retry",
            payloadJson: JSON.stringify({ updatedCount }),
        });

        await this.bootstrapQueuePort.publishBootstrapMetadataProcess({
            chainId: run.chainId,
            runId: run.runId,
            collectionId: run.collectionId,
            address: run.requestAddress,
            standard: run.requestStandard,
            metadataMode: run.metadataMode,
            anchorBlock: run.anchorBlock,
            anchorHash: run.anchorBlockHash,
            anchorTimestamp: run.anchorBlockTimestamp,
        });

        return {
            runId: run.runId,
            updatedCount,
            status: BOOTSTRAP_RUN_STATUS.Metadata,
        };
    }
}
