import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TokenCard,
} from "@artgod/shared/types";
import { buildTokenPresentationIncludes } from "../collections/token-presentation-summary.js";
import type { BiddingJobsRepositoryPort } from "./ports.js";
import type {
    BiddingJobView,
    ListCollectionBiddingJobsOutput,
} from "./types.js";
import { mapPersistedBiddingJobToView } from "./types.js";
export type { ListCollectionBiddingJobsOutput } from "./types.js";

export type ListCollectionBiddingJobsInput = {
    chainRef: string;
    collectionRef: string;
    mediaMode?: string;
};

export class ListCollectionBiddingJobsUseCase {
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
            getCollectionMediaState(params: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
            }): CollectionMediaState;
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
                mediaMode?: string;
                includeListings?: boolean;
            }): TokenCard[];
        },
        readonly customizationReadPort: {
            getActivityRowTraitSummaryTemplateState(params: {
                chainId: number;
                collectionId: number;
            }): {
                effectiveConfig: {
                    template: string;
                };
            };
        },
        readonly biddingJobsRepositoryPort: Pick<
            BiddingJobsRepositoryPort,
            "listCollectionJobs"
        >,
    ) {}

    listCollectionBiddingJobs(
        input: ListCollectionBiddingJobsInput,
    ): ListCollectionBiddingJobsOutput {
        // Resolve the requested chain against the configured backend default.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection before reading its declared bidding jobs.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Resolve collection media so job token previews use the same media lane as activities.
        const media = this.collectionReadPort.getCollectionMediaState({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            mediaMode: input.mediaMode,
        });
        // Load the authoritative bidding jobs declared for this collection.
        const jobs = this.biddingJobsRepositoryPort
            .listCollectionJobs({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            })
            .map((job) => mapPersistedBiddingJobToView(job));
        const tokenIds = collectTokenJobIds(jobs);
        // Load compact token summaries for token-scoped jobs before rendering preview cells.
        const tokenCards = this.collectionReadPort.listCollectionTokenCardsByIds({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenIds,
            mediaMode: media.selectedMode,
        });
        // Reuse the activity-row trait-summary presentation for compact token rows.
        const traitSummaryTemplate =
            this.customizationReadPort.getActivityRowTraitSummaryTemplateState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const included = buildTokenPresentationIncludes(
            tokenCards,
            traitSummaryTemplate.effectiveConfig.template,
        );

        return {
            chain,
            collection,
            media,
            jobs,
            included,
        };
    }
}

function collectTokenJobIds(jobs: BiddingJobView[]): string[] {
    const tokenIds: string[] = [];
    const seen = new Set<string>();

    for (const job of jobs) {
        if (job.target.type !== "token" || seen.has(job.target.tokenId)) {
            continue;
        }
        seen.add(job.target.tokenId);
        tokenIds.push(job.target.tokenId);
    }

    return tokenIds;
}
