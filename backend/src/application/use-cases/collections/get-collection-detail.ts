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
import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";
import { applyTraitFilterPresentationToFacets } from "@artgod/shared/read-models/collections";
import { renderTraitSummaryTemplate } from "@artgod/shared/types";

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
                "artgod.chain_id": chain.publicChainId,
            },
            () =>
                this.collectionDetailReadPort.resolveCollectionRef(
                    chain.publicChainId,
                    input.collectionRef,
                ),
        );
        const attributes = {
            "artgod.chain_id": chain.publicChainId,
            "artgod.collection_id": collection.collectionId,
        };

        const media = this.apm.withSyncSpan(
            "backend.collection_detail.media_state",
            attributes,
            () =>
                this.collectionDetailReadPort.getCollectionMediaState({
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    mediaMode: input.mediaMode,
                }),
        );

        const tokens = this.apm.withSyncSpan(
            "backend.collection_detail.tokens",
            {
                ...attributes,
                "artgod.collection.token_status": input.tokenStatus,
                "artgod.collection.limit": input.limit,
                "artgod.collection.cursor_present": Boolean(input.cursor),
                "artgod.collection.trait_filters_count": input.traits.length,
                "artgod.collection.trait_ranges_count":
                    input.traitRanges.length,
                "artgod.collection.owner_present": Boolean(input.owner),
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
                "artgod.collection.owner_present": Boolean(input.owner),
                "artgod.collection.range_only_keys_count":
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
                "artgod.tokens.count": tokens.items.length,
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
