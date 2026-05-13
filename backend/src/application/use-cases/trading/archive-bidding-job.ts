import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import type { BiddingJobView } from "./types.js";
import { mapPersistedBiddingJobToView } from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";

export type ArchiveBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    jobId: string;
};

export type ArchiveBiddingJobOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    job: BiddingJobView;
};

// ArchiveBiddingJobUseCase archives any declared bidding job target by job id.
export class ArchiveBiddingJobUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "archiveJobById"
        >,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    archiveBiddingJob(input: ArchiveBiddingJobInput): ArchiveBiddingJobOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before archiving a job scoped to it.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );

        // Archive the declared job and enqueue the matching cleanup commands atomically.
        const result = this.biddingJobsRepositoryPort.archiveJobById({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            jobId: input.jobId,
        });
        if (!result) {
            throw new ReadModelNotFoundError("Unknown bidding job");
        }
        // Publish a post-commit wake-up so the running bot scans the durable cleanup commands immediately.
        this.tradingJobCommandSignalPort.publishBiddingJobCommandsChanged(
            result.commands,
        );

        return {
            chain,
            collection,
            job: mapPersistedBiddingJobToView(result.job),
        };
    }
}
