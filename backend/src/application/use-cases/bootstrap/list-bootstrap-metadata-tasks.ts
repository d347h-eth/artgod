import { ReadModelBadRequestError, ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type {
    BootstrapRunsWritePort,
    ChainRefResolverPort,
} from "./ports.js";
import type { BootstrapMetadataTaskStatus } from "./types.js";

export type ListBootstrapMetadataTasksInput = {
    chainRef: string;
    collectionRef: string;
    status?: BootstrapMetadataTaskStatus;
    limit: number;
    cursor?: string;
};

export type ListBootstrapMetadataTasksOutput = {
    runId: number;
    items: Array<{
        tokenId: string;
        status: BootstrapMetadataTaskStatus;
        attempts: number;
        nextAttemptAt: number;
        lastError: string | null;
        lastErrorAt: number | null;
    }>;
    nextCursor: string | null;
    limit: number;
};

export class ListBootstrapMetadataTasksUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
    ) {}

    listTasks(
        input: ListBootstrapMetadataTasksInput,
    ): ListBootstrapMetadataTasksOutput {
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
        if (!Number.isInteger(input.limit) || input.limit <= 0) {
            throw new ReadModelBadRequestError("Invalid limit");
        }
        const page = this.bootstrapRunsPort.listRunMetadataTasks({
            runId: latestRun.runId,
            status: input.status,
            limit: input.limit,
            cursor: input.cursor,
        });
        return {
            runId: latestRun.runId,
            items: page.items,
            nextCursor: page.nextCursor,
            limit: input.limit,
        };
    }
}
