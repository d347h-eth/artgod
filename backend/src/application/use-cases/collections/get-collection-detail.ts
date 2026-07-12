import type {
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenBrowserStatus,
    TokenCursorPage,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { applyTraitFilterPresentationToFacets } from "@artgod/shared/read-models/collections";
import { renderTraitSummaryTemplate } from "@artgod/shared/types";
import type { CollectionMediaPreferenceValue } from "@artgod/shared/extensions";

export type GetCollectionDetailInput = {
    chainRef: string;
    collectionRef: string;
    tokenStatus: TokenBrowserStatus;
    limit: number;
    cursor?: string;
    traits: TraitFilter[];
    traitRanges: TraitRangeFilter[];
    owner?: string;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
};

export type GetCollectionDetailOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    traits: {
        selected: TraitFilter[];
        selectedRanges: TraitRangeFilter[];
        facets: TraitFacet[];
    };
    media: CollectionMediaState;
    tokens: TokenCursorPage;
};

export type GetCollectionDetailPort = {
    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): GetCollectionDetailOutput | Promise<GetCollectionDetailOutput>;
};

export class GetCollectionDetailUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionDetailReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            listCollectionTokens(params: {
                chainId: number;
                collectionId: number;
                tokenStatus: TokenBrowserStatus;
                limit: number;
                cursor?: string;
                traitFilters?: TraitFilter[];
                traitRangeFilters?: TraitRangeFilter[];
                owner?: string;
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
            }): TokenCursorPage;
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
                mediaPreference?: CollectionMediaPreferenceValue;
            }): CollectionMediaState;
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
            getTokenCardTraitSummaryTemplateState(params: {
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

    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): GetCollectionDetailOutput {
        const chain = this.apm.withSyncSpan(
            "backend.collection_detail.chain",
            {},
            () =>
                this.chainRefResolverPort.resolveChainRef(
                    input.chainRef,
                    this.defaultChainId,
                ),
        );

        const collection = this.apm.withSyncSpan(
            "backend.collection_detail.collection",
            {
                [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            },
            () =>
                this.collectionDetailReadPort.resolveCollectionRef(
                    chain.publicChainId,
                    input.collectionRef,
                ),
        );
        const attributes = {
            [ARTGOD_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            [ARTGOD_SPAN_ATTRIBUTE.CollectionId]: collection.collectionId,
        };

        const media = this.apm.withSyncSpan(
            "backend.collection_detail.media_state",
            attributes,
            () =>
                this.collectionDetailReadPort.getCollectionMediaState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    mediaMode: input.mediaMode,
                    mediaPreference: input.mediaPreference,
                }),
        );

        const tokens = this.apm.withSyncSpan(
            "backend.collection_detail.tokens",
            {
                ...attributes,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionTokenStatus]:
                    input.tokenStatus,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionLimit]: input.limit,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionCursorPresent]: Boolean(
                    input.cursor,
                ),
                [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitFiltersCount]:
                    input.traits.length,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionTraitRangesCount]:
                    input.traitRanges.length,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]: Boolean(
                    input.owner,
                ),
            },
            () =>
                this.collectionDetailReadPort.listCollectionTokens({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    tokenStatus: input.tokenStatus,
                    limit: input.limit,
                    cursor: input.cursor,
                    traitFilters: input.traits,
                    traitRangeFilters: input.traitRanges,
                    owner: input.owner,
                    mediaMode: media.selectedMode,
                    mediaPreference: input.mediaPreference,
                }),
        );
        const traitFilterPresentation = this.apm.withSyncSpan(
            "backend.collection_detail.trait_filter_presentation",
            attributes,
            () =>
                this.customizationReadPort.getTraitFilterPresentationState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                }),
        );
        const rawFacets = this.apm.withSyncSpan(
            "backend.collection_detail.trait_facets",
            {
                ...attributes,
                [ARTGOD_SPAN_ATTRIBUTE.CollectionOwnerPresent]: Boolean(
                    input.owner,
                ),
                [ARTGOD_SPAN_ATTRIBUTE.CollectionRangeOnlyKeysCount]:
                    traitFilterPresentation.effectiveConfig.rangeKeys.length,
            },
            () =>
                this.collectionDetailReadPort.listCollectionTraitFacets(
                    chain.publicChainId,
                    collection.collectionId,
                    input.owner,
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
        const tokenCardTraitSummaryTemplate = this.apm.withSyncSpan(
            "backend.collection_detail.token_summary_template",
            attributes,
            () =>
                this.customizationReadPort.getTokenCardTraitSummaryTemplateState(
                    {
                        chainId: chain.publicChainId,
                        collectionId: collection.collectionId,
                    },
                ),
        );
        const tokensWithTraitSummary = this.apm.withSyncSpan(
            "backend.collection_detail.token_summary_render",
            {
                ...attributes,
                [ARTGOD_SPAN_ATTRIBUTE.TokensCount]: tokens.items.length,
            },
            () =>
                applyTokenCardTraitSummaryTemplate(
                    tokens,
                    tokenCardTraitSummaryTemplate.effectiveConfig.template,
                ),
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
            tokens: tokensWithTraitSummary,
        };
    }
}

function applyTokenCardTraitSummaryTemplate(
    page: TokenCursorPage,
    template: string,
): TokenCursorPage {
    return {
        ...page,
        items: page.items.map((token) => ({
            ...token,
            traitSummary: renderTraitSummaryTemplate(
                template,
                token.attributes,
            ),
        })),
    };
}
