import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import type { ArchiveTokenBiddingJobOutput } from "./types.js";
import { mapPersistedTokenBiddingJobToView } from "./types.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
export type { ArchiveTokenBiddingJobOutput } from "./types.js";

export type ArchiveTokenBiddingJobInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
};

export class ArchiveTokenBiddingJobUseCase {
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
            getCollectionTokenDetail(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
            }): { tokenId: string };
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "archiveTokenJob"
        >,
        readonly tradingJobCommandSignalPort: TradingJobCommandSignalPort,
    ) {}

    archiveTokenBiddingJob(
        input: ArchiveTokenBiddingJobInput,
    ): ArchiveTokenBiddingJobOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before mutating its token-scoped job.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Verify the token exists in this collection before archiving its job.
        const token = this.collectionReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
        });

        // Archive the declared job and enqueue the matching cleanup commands.
        const result = this.biddingJobsRepositoryPort.archiveTokenJob({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
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
            tokenId: token.tokenId,
            job: mapPersistedTokenBiddingJobToView(result.job),
        };
    }
}
