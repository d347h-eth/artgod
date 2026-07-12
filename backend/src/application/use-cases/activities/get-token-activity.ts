import type {
    ActivityFeedIncludes,
    ActivityFeedPage,
    ActivityFeedFilterKind,
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TokenDetail,
    TokenMediaState,
} from "@artgod/shared/types";
import {
    buildActivityFeedIncludes,
    collectActivityTokenIds,
} from "./token-presentation-summary.js";
import type { CollectionMediaPreferenceValue } from "@artgod/shared/extensions";

type MaybePromise<T> = T | Promise<T>;

export type GetTokenActivityInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    limit: number;
    cursor?: string;
    kind?: ActivityFeedFilterKind;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
};

export type GetTokenActivityOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    media: TokenMediaState;
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
            getCollectionTokenDetailPresentation(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
            }): MaybePromise<{
                media: TokenMediaState;
                token: TokenDetail;
            }>;
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
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
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
    ) {}

    async getTokenActivity(
        input: GetTokenActivityInput,
    ): Promise<GetTokenActivityOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Resolve media selection and token presentation against one extension-read context.
        const { media, token } =
            await this.collectionReadPort.getCollectionTokenDetailPresentation({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenId: input.tokenRef,
                mediaMode: input.mediaMode,
                mediaPreference: input.mediaPreference,
            });
        const activities = this.activityReadPort.listTokenActivities({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            limit: input.limit,
            cursor: input.cursor,
            kind: input.kind,
        });
        const activityRowTraitSummaryTemplate =
            this.customizationReadPort.getActivityRowTraitSummaryTemplateState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const included = buildActivityFeedIncludes(
            this.tokenPresentationReadPort.listCollectionTokenCardsByIds({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenIds: collectActivityTokenIds(activities.items),
                mediaMode: media.selectedMode,
                mediaPreference: input.mediaPreference,
            }),
            activityRowTraitSummaryTemplate.effectiveConfig.template,
        );

        return {
            chain,
            collection,
            media,
            token,
            activities,
            included,
        };
    }
}
