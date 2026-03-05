import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    BootstrapRunsWritePort,
    ChainRefResolverPort,
    CollectionBootstrapState,
} from "./ports.js";
import type { BootstrapRunStatus, ListBootstrapRunsOutput } from "./types.js";

export type ListBootstrapRunsInput = {
    chainRef: string;
    status?: BootstrapRunStatus;
    limit: number;
    cursor?: string;
};

export class ListBootstrapRunsUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
    ) {}

    listRuns(input: ListBootstrapRunsInput): ListBootstrapRunsOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const cursorRunId = parseCursorRunId(input.cursor);
        const page = this.bootstrapRunsPort.listRunsByChain({
            chainId: chain.publicChainId,
            status: input.status,
            limit: input.limit,
            cursorRunId,
        });

        const items = page.items.map((run) => {
            const collection = this.bootstrapRunsPort.getCollectionById(
                chain.publicChainId,
                run.collectionId,
            );
            if (!collection) {
                throw new Error(
                    `Collection not found for bootstrap run ${run.runId}`,
                );
            }
            return {
                run,
                collection: mapCollectionSummary(collection),
                metadataTasks: this.bootstrapRunsPort.getRunTaskCounts(
                    run.runId,
                ),
            };
        });

        return {
            chain,
            filters: {
                status: input.status,
            },
            page: {
                items,
                nextCursor: page.nextCursor,
                limit: input.limit,
            },
        };
    }
}

function parseCursorRunId(raw: string | undefined): number | undefined {
    if (!raw || !raw.trim()) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ReadModelBadRequestError("Invalid bootstrap runs cursor");
    }
    return parsed;
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
