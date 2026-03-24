import type {
    ChainRecord,
    CollectionCustomization,
    CollectionListItem,
    TraitFacet,
} from "@artgod/shared/types";

export type GetCollectionCustomizationInput = {
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
        readonly customizationReadPort: {
            getTraitFilterPresentationState(params: {
                chainId: number;
                collectionId: number;
                availableTraitKeys?: string[];
            }): CollectionCustomization["traitFilterPresentation"];
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
        const traitKeys = this.collectionReadPort
            .listCollectionTraitFacets(chain.publicChainId, collection.collectionId)
            .map((facet) => facet.key);
        const traitFilterPresentation =
            this.customizationReadPort.getTraitFilterPresentationState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                availableTraitKeys: traitKeys,
            });

        return {
            chain,
            collection,
            customization: {
                traitFilterPresentation,
            },
        };
    }
}
