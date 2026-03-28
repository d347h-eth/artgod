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
    ) {}

    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): GetCollectionDetailOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );

        const collection = this.collectionDetailReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );

        const media = this.collectionDetailReadPort.getCollectionMediaState({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            mediaMode: input.mediaMode,
        });

        const tokens = this.collectionDetailReadPort.listCollectionTokens({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenStatus: input.tokenStatus,
            limit: input.limit,
            cursor: input.cursor,
            traitFilters: input.traits,
            traitRangeFilters: input.traitRanges,
            owner: input.owner,
            mediaMode: media.selectedMode,
        });

        const rawFacets = this.collectionDetailReadPort.listCollectionTraitFacets(
            chain.publicChainId,
            collection.collectionId,
            input.owner,
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
        const tokenCardTraitSummaryTemplate =
            this.customizationReadPort.getTokenCardTraitSummaryTemplateState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const tokensWithTraitSummary = applyTokenCardTraitSummaryTemplate(
            tokens,
            tokenCardTraitSummaryTemplate.effectiveConfig.template,
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
            traitSummary: renderTraitSummaryTemplate(template, token.attributes),
        })),
    };
}
