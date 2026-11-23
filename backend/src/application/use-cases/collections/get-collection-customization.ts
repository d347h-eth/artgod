import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
} from "./collection-views.js";
import type {
    ChainRecord,
    CollectionCustomization,
    CollectionListItem,
    TraitFacet,
} from "@artgod/shared/types";

export type GetCollectionCustomizationInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
};

export type GetCollectionCustomizationOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    customization: CollectionCustomization;
};

export class GetCollectionCustomizationUseCase {
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
            listCollectionTraitFacets(
                chainId: number,
                collectionId: number,
                owner?: string,
                options?: { traitContext?: TraitReadContext },
            ): TraitFacet[];
        },
        readonly customizationReadPort: {
            getTraitFilterPresentationState(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
                availableTraitKeys?: string[];
            }): CollectionCustomization["traitFilterPresentation"];
            getTokenCardTraitSummaryTemplateState(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
            }): CollectionCustomization["tokenCardTraitSummaryTemplate"];
            getActivityRowTraitSummaryTemplateState(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
            }): CollectionCustomization["activityRowTraitSummaryTemplate"];
            getImageCachePolicyState(params: {
                chainId: number;
                collectionId: number;
            }): CollectionCustomization["imageCachePolicy"];
            getMediaPurposePolicyState(params: {
                chainId: number;
                collectionId: number;
            }): CollectionCustomization["mediaPurposePolicy"];
        },
    ) {}

    getCollectionCustomization(
        input: GetCollectionCustomizationInput,
    ): GetCollectionCustomizationOutput {
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
        );
        const traitKeys = this.collectionReadPort
            .listCollectionTraitFacets(
                chain.publicChainId,
                collection.collectionId,
                undefined,
                { traitContext },
            )
            .map((facet) => facet.key);
        const traitFilterPresentation =
            this.customizationReadPort.getTraitFilterPresentationState({
                traitContext,
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                availableTraitKeys: traitKeys,
            });
        const tokenCardTraitSummaryTemplate =
            this.customizationReadPort.getTokenCardTraitSummaryTemplateState({
                traitContext,
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const activityRowTraitSummaryTemplate =
            this.customizationReadPort.getActivityRowTraitSummaryTemplateState({
                traitContext,
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const imageCachePolicy =
            this.customizationReadPort.getImageCachePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const mediaPurposePolicy =
            this.customizationReadPort.getMediaPurposePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });

        return {
            chain,
            collection,
            customization: {
                traitFilterPresentation,
                tokenCardTraitSummaryTemplate,
                activityRowTraitSummaryTemplate,
                imageCachePolicy,
                mediaPurposePolicy,
            },
        };
    }
}
