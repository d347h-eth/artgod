import type {
    ChainRecord,
    CollectionCustomization,
    CollectionCustomizationSourceKind,
    CollectionListItem,
    TraitFacet,
    TraitFilterPresentationConfig,
} from "@artgod/shared/types";

export type UpdateCollectionCustomizationInput = {
    chainRef: string;
    collectionRef: string;
    traitFilterPresentation: {
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitFilterPresentationConfig;
    };
};

export type UpdateCollectionCustomizationOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    customization: CollectionCustomization;
};

export class UpdateCollectionCustomizationUseCase {
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
        readonly customizationWritePort: {
            updateTraitFilterPresentationState(params: {
                chainId: number;
                collectionId: number;
                selectedSource: CollectionCustomizationSourceKind;
                userConfig: TraitFilterPresentationConfig;
                availableTraitKeys?: string[];
            }): CollectionCustomization["traitFilterPresentation"];
        },
    ) {}

    updateCollectionCustomization(
        input: UpdateCollectionCustomizationInput,
    ): UpdateCollectionCustomizationOutput {
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
            this.customizationWritePort.updateTraitFilterPresentationState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                selectedSource: input.traitFilterPresentation.selectedSource,
                userConfig: input.traitFilterPresentation.userConfig,
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
