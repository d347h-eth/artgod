import type {
    ActivityFeedIncludes,
    ActivityFeedPage,
    ActivityFeedFilterKind,
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenCard,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types";
import { applyTraitFilterPresentationToFacets } from "@artgod/shared/read-models/collections";
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
    traitRanges: TraitRangeFilter[];
    mediaMode?: string;
};

export type GetCollectionActivityOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    traits: {
        selected: TraitFilter[];
        selectedRanges: TraitRangeFilter[];
        facets: TraitFacet[];
    };
    media: CollectionMediaState;
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
            getCollectionMediaState(params: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
            }): CollectionMediaState;
        },
        readonly activityReadPort: {
            listCollectionActivities(params: {
                chainId: number;
                collectionId: number;
                limit: number;
                cursor?: string;
                kind?: ActivityFeedFilterKind;
                traitFilters?: TraitFilter[];
                traitRangeFilters?: TraitRangeFilter[];
            }): ActivityFeedPage;
        },
        readonly tokenPresentationReadPort: {
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
                mediaMode?: string;
            }): TokenCard[];
        },
        readonly customizationReadPort: {
            getTraitFilterPresentationState(params: {
                chainId: number;
                collectionId: number;
                availableTraitKeys?: string[];
            }): {
                effectiveConfig: {
                    rangeKeys: string[];
                };
            };
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
        const media = this.collectionReadPort.getCollectionMediaState({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            mediaMode: input.mediaMode,
        });
        const activities = this.activityReadPort.listCollectionActivities({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            limit: input.limit,
            cursor: input.cursor,
            kind: input.kind,
            traitFilters: input.traits,
            traitRangeFilters: input.traitRanges,
        });
        const rawFacets = this.collectionReadPort.listCollectionTraitFacets(
            chain.publicChainId,
            collection.collectionId,
        );
        const traitFilterPresentation =
            this.customizationReadPort.getTraitFilterPresentationState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                availableTraitKeys: rawFacets.map((facet) => facet.key),
            });
        const facets = applyTraitFilterPresentationToFacets({
            facets: rawFacets,
            config: traitFilterPresentation.effectiveConfig,
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
            }),
            activityRowTraitSummaryTemplate.effectiveConfig.template,
        );

        return {
            chain,
            collection,
            traits: {
                selected: input.traits,
                selectedRanges: input.traitRanges,
                facets,
            },
            media,
            activities,
            included,
        };
    }
}
