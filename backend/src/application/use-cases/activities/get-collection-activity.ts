import type {
    ActivityFeedIncludes,
    ActivityFeedPage,
    ActivityFeedFilterKind,
    ChainRecord,
    CollectionListItem,
    TokenCard,
    TraitFacet,
    TraitFilter,
} from "@artgod/shared/types";
import {
    buildActivityFeedIncludes,
    collectActivityTokenIds,
} from "./token-presentation-summary.js";

export type GetCollectionActivityInput = {
    chainRef: string;
    collectionRef: string;
    limit: number;
    cursor?: string;
    kind?: ActivityFeedFilterKind;
    traits: TraitFilter[];
};

export type GetCollectionActivityOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    traits: {
        selected: TraitFilter[];
        facets: TraitFacet[];
    };
    activities: ActivityFeedPage;
    included: ActivityFeedIncludes;
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
            listCollectionTraitFacets(
                chainId: number,
                collectionId: number,
            ): TraitFacet[];
        },
        readonly activityReadPort: {
            listCollectionActivities(params: {
                chainId: number;
                collectionId: number;
                limit: number;
                cursor?: string;
                kind?: ActivityFeedFilterKind;
                traitFilters?: TraitFilter[];
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
            traitFilters: input.traits,
        });
        const facets = this.collectionReadPort.listCollectionTraitFacets(
            chain.publicChainId,
            collection.collectionId,
        );
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
            traits: {
                selected: input.traits,
                facets,
            },
            activities,
            included,
        };
    }
}
