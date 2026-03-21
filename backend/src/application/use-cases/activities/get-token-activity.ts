import type {
    ActivityFeedIncludes,
    ActivityFeedPage,
    ActivityFeedFilterKind,
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TokenDetail,
} from "@artgod/shared/types";
import {
    buildActivityFeedIncludes,
    collectActivityTokenIds,
} from "./token-presentation-summary.js";

export type GetTokenActivityInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    limit: number;
    cursor?: string;
    kind?: ActivityFeedFilterKind;
};

export type GetTokenActivityOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    token: TokenDetail;
    activities: ActivityFeedPage;
    included: ActivityFeedIncludes;
};

export class GetTokenActivityUseCase {
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
            }): TokenDetail;
        },
        readonly activityReadPort: {
            listTokenActivities(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
                limit: number;
                cursor?: string;
                kind?: ActivityFeedFilterKind;
            }): ActivityFeedPage;
        },
        readonly tokenPresentationReadPort: {
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
            }): TokenCard[];
        },
    ) {}

    getTokenActivity(input: GetTokenActivityInput): GetTokenActivityOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const token = this.collectionReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
        });
        const activities = this.activityReadPort.listTokenActivities({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            limit: input.limit,
            cursor: input.cursor,
            kind: input.kind,
        });
        const included = buildActivityFeedIncludes(
            this.tokenPresentationReadPort.listCollectionTokenCardsByIds({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenIds: collectActivityTokenIds(activities.items),
            }),
        );

        return {
            chain,
            collection,
            token,
            activities,
            included,
        };
    }
}
