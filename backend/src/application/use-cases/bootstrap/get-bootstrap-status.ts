import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { BootstrapRunsWritePort, ChainRefResolverPort } from "./ports.js";
import type { BootstrapStatusOutput } from "./types.js";

export type GetBootstrapStatusInput = {
    chainRef: string;
    collectionRef: string;
};

export class GetBootstrapStatusUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
    ) {}

    getStatus(input: GetBootstrapStatusInput): BootstrapStatusOutput {
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
        const counts = latestRun
            ? this.bootstrapRunsPort.getRunTaskCounts(latestRun.runId)
            : {
                  pending: 0,
                  retry: 0,
                  succeeded: 0,
                  failedTerminal: 0,
                  total: 0,
              };
        return {
            collection,
            latestRun,
            metadataTasks: counts,
        };
    }
}
