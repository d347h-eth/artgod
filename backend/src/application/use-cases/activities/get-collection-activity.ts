import type {
    ActivityEventMedia,
    ActivityFeedIncludes,
    ActivityExtensionEventFilter,
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
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
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
    tokenId?: string;
    maker?: string;
    contentHash?: string;
    eventGroup?: string;
    extensionEvent?: ActivityExtensionEventFilter;
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
                owner?: string,
                options?: {
                    rangeOnlyKeys?: string[];
                },
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
                extensionEvent?: ActivityExtensionEventFilter;
                tokenId?: string;
                maker?: string;
                contentHash?: string;
                eventGroup?: string;
                traitFilters?: TraitFilter[];
                traitRangeFilters?: TraitRangeFilter[];
            }): ActivityFeedPage;
            listCollectionActivityEventMedia(params: {
                chainId: number;
                collectionId: number;
                activityIds: number[];
            }): Record<string, ActivityEventMedia>;
        },
        readonly tokenPresentationReadPort: {
            listCollectionTokenCardsByIds(params: {
                chainId: number;
                collectionId: number;
                tokenIds: string[];
                mediaMode?: string;
                includeListings?: boolean;
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
        readonly apm: ApmPort = NOOP_APM,
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
        const activityAttributes = {
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: collection.collectionId,
        };
        const media = this.apm.withSyncSpan(
            "backend.activity.media_state",
            activityAttributes,
            () =>
                this.collectionReadPort.getCollectionMediaState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    mediaMode: input.mediaMode,
                }),
        );
        const activities = this.apm.withSyncSpan(
            "backend.activity.feed",
            {
                ...activityAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityLimit]: input.limit,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityCursorPresent]:
                    Boolean(input.cursor),
                [ARTGOD_SPAN_ATTRIBUTE.ActivityTraitsCount]:
                    input.traits.length,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityTraitRangesCount]:
                    input.traitRanges.length,
            },
            () =>
                this.activityReadPort.listCollectionActivities({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    limit: input.limit,
                    cursor: input.cursor,
                    kind: input.kind,
                    extensionEvent: input.extensionEvent,
                    tokenId: input.tokenId,
                    maker: input.maker,
                    contentHash: input.contentHash,
                    eventGroup: input.eventGroup,
                    traitFilters: input.traits,
                    traitRangeFilters: input.traitRanges,
                }),
        );
        const traitFilterPresentation = this.apm.withSyncSpan(
            "backend.activity.trait_filter_presentation",
            activityAttributes,
            () =>
                this.customizationReadPort.getTraitFilterPresentationState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                }),
        );
        const rawFacets = this.apm.withSyncSpan(
            "backend.activity.trait_facets",
            {
                ...activityAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityRangeOnlyKeysCount]:
                    traitFilterPresentation.effectiveConfig.rangeKeys.length,
            },
            () =>
                this.collectionReadPort.listCollectionTraitFacets(
                    chain.publicChainId,
                    collection.collectionId,
                    undefined,
                    {
                        rangeOnlyKeys:
                            traitFilterPresentation.effectiveConfig.rangeKeys,
                    },
                ),
        );
        const facets = applyTraitFilterPresentationToFacets({
            facets: rawFacets,
            config: traitFilterPresentation.effectiveConfig,
        });
        const activityRowTraitSummaryTemplate = this.apm.withSyncSpan(
            "backend.activity.trait_summary_template",
            activityAttributes,
            () =>
                this.customizationReadPort.getActivityRowTraitSummaryTemplateState(
                    {
                        chainId: chain.publicChainId,
                        collectionId: collection.collectionId,
                    },
                ),
        );
        const activityTokenIds = collectActivityTokenIds(activities.items);
        const activityIds = activities.items.map((activity) => activity.id);
        const tokenCards = this.apm.withSyncSpan(
            "backend.activity.token_includes",
            {
                ...activityAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityTokenIdsCount]:
                    activityTokenIds.length,
            },
            () =>
                this.tokenPresentationReadPort.listCollectionTokenCardsByIds({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    tokenIds: activityTokenIds,
                    mediaMode: media.selectedMode,
                }),
        );
        const eventMediaByActivityId = this.apm.withSyncSpan(
            "backend.activity.event_media",
            {
                ...activityAttributes,
                [ARTGOD_SPAN_ATTRIBUTE.ActivityActivityIdsCount]:
                    activityIds.length,
            },
            () =>
                this.activityReadPort.listCollectionActivityEventMedia({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    activityIds,
                }),
        );
        const included = buildActivityFeedIncludes(
            tokenCards,
            activityRowTraitSummaryTemplate.effectiveConfig.template,
            eventMediaByActivityId,
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
