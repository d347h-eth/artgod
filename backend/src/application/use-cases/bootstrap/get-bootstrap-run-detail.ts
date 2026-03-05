import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type {
    BootstrapRunsWritePort,
    ChainRefResolverPort,
    CollectionBootstrapState,
} from "./ports.js";
import type { BootstrapRunDetailOutput } from "./types.js";

export type GetBootstrapRunDetailInput = {
    chainRef: string;
    runId: number;
};

const FAILED_TASKS_PREVIEW_LIMIT = 50;

export class GetBootstrapRunDetailUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
    ) {}

    getRunDetail(input: GetBootstrapRunDetailInput): BootstrapRunDetailOutput {
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
        const collection = this.bootstrapRunsPort.getCollectionById(
            chain.publicChainId,
            run.collectionId,
        );
        if (!collection) {
            throw new ReadModelNotFoundError(
                "Unknown collection for bootstrap run",
            );
        }
        const counts = this.bootstrapRunsPort.getRunTaskCounts(run.runId);
        const failedTasksPreview = this.bootstrapRunsPort.listRunMetadataTasks({
            runId: run.runId,
            status: "failed_terminal",
            limit: FAILED_TASKS_PREVIEW_LIMIT,
        });

        return {
            run,
            collection: mapCollectionSummary(collection),
            metadataTasks: counts,
            failedMetadataTasksPreview: failedTasksPreview.items,
            failedMetadataTasksPreviewLimit: FAILED_TASKS_PREVIEW_LIMIT,
            isLatestForCollection:
                this.bootstrapRunsPort.isLatestRunForCollection(
                    chain.publicChainId,
                    run.collectionId,
                    run.runId,
                ),
        };
    }
}

function mapCollectionSummary(collection: CollectionBootstrapState): {
    chainId: number;
    collectionId: number;
    slug: string | null;
    address: string;
    status: "bootstrapping" | "live" | "paused" | "disabled";
} {
    return {
        chainId: collection.chainId,
        collectionId: collection.collectionId,
        slug: collection.slug,
        address: collection.address,
        status: collection.status,
    };
}
