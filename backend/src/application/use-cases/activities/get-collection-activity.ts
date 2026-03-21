import type {
    ActivityFeedPage,
    ActivityFeedFilterKind,
    ChainRecord,
    CollectionListItem,
} from "@artgod/shared/types";

export type GetCollectionActivityInput = {
    chainRef: string;
    collectionRef: string;
    limit: number;
    cursor?: string;
    kind?: ActivityFeedFilterKind;
};

export type GetCollectionActivityOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    activities: ActivityFeedPage;
};

export class GetCollectionActivityUseCase {
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
        readonly activityReadPort: {
            listCollectionActivities(params: {
                chainId: number;
                collectionId: number;
                limit: number;
                cursor?: string;
                kind?: ActivityFeedFilterKind;
            }): ActivityFeedPage;
        },
    ) {}

    getCollectionActivity(
        input: GetCollectionActivityInput,
    ): GetCollectionActivityOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const activities = this.activityReadPort.listCollectionActivities({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            limit: input.limit,
            cursor: input.cursor,
            kind: input.kind,
        });

        return {
            chain,
            collection,
            activities,
        };
    }
}
