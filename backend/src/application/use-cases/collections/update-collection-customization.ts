import type {
    ChainRecord,
    CollectionCustomization,
    CollectionCustomizationSourceKind,
    CollectionListItem,
    TraitFacet,
    TraitFilterPresentationConfig,
    TraitSummaryTemplateConfig,
} from "@artgod/shared/types";

export type UpdateCollectionCustomizationInput = {
    chainRef: string;
    collectionRef: string;
    traitFilterPresentation: {
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitFilterPresentationConfig;
    };
    tokenCardTraitSummaryTemplate: {
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitSummaryTemplateConfig;
    };
    activityRowTraitSummaryTemplate: {
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: TraitSummaryTemplateConfig;
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
            updateTokenCardTraitSummaryTemplateState(params: {
                chainId: number;
                collectionId: number;
                selectedSource: CollectionCustomizationSourceKind;
                userConfig: TraitSummaryTemplateConfig;
            }): CollectionCustomization["tokenCardTraitSummaryTemplate"];
            updateActivityRowTraitSummaryTemplateState(params: {
                chainId: number;
                collectionId: number;
                selectedSource: CollectionCustomizationSourceKind;
                userConfig: TraitSummaryTemplateConfig;
            }): CollectionCustomization["activityRowTraitSummaryTemplate"];
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
        const tokenCardTraitSummaryTemplate =
            this.customizationWritePort.updateTokenCardTraitSummaryTemplateState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                selectedSource: input.tokenCardTraitSummaryTemplate.selectedSource,
                userConfig: input.tokenCardTraitSummaryTemplate.userConfig,
            });
        const activityRowTraitSummaryTemplate =
            this.customizationWritePort.updateActivityRowTraitSummaryTemplateState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                selectedSource:
                    input.activityRowTraitSummaryTemplate.selectedSource,
                userConfig: input.activityRowTraitSummaryTemplate.userConfig,
            });

        return {
            chain,
            collection,
            customization: {
                traitFilterPresentation,
                tokenCardTraitSummaryTemplate,
                activityRowTraitSummaryTemplate,
            },
        };
    }
}
