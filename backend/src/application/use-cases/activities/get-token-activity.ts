import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
    wrapCatalogPage,
    unwrapCatalogCursor,
} from "../collections/collection-views.js";
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

export type GetTokenActivityInput = CatalogRequest & {
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
        readonly collectionReadPort: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            getCollectionTokenDetailPresentation(params: {
                traitContext?: TraitReadContext;
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
                traitContext?: TraitReadContext;
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
                traitContext?: TraitReadContext;
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
                traitContext?: TraitReadContext;
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
        const { traitContext } = resolveTraitScope(
            this.collectionReadPort,
            collection,
            input,
            input.tokenRef,
        );
        // Resolve media selection and token presentation against one extension-read context.
        const { media, token } =
            await this.collectionReadPort.getCollectionTokenDetailPresentation({
                traitContext,
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                tokenId: input.tokenRef,
                mediaMode: input.mediaMode,
                mediaPreference: input.mediaPreference,
            });
        const activities = this.activityReadPort.listTokenActivities({
            traitContext,
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            limit: input.limit,
            cursor: unwrapCatalogCursor(input.cursor, traitContext),
            kind: input.kind,
        });
        const activityRowTraitSummaryTemplate =
            this.customizationReadPort.getActivityRowTraitSummaryTemplateState({
                traitContext,
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const included = buildActivityFeedIncludes(
            this.tokenPresentationReadPort.listCollectionTokenCardsByIds({
                traitContext,
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
            activities: wrapCatalogPage(activities, traitContext),
            included,
        };
    }
}
