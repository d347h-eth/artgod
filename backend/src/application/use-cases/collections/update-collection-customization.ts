import type {
    ChainRecord,
    CollectionCustomization,
    CollectionCustomizationSourceKind,
    ImageCachePolicyConfig,
    CollectionListItem,
    TraitFacet,
    TraitFilterPresentationConfig,
    TraitSummaryTemplateConfig,
} from "@artgod/shared/types";
import {
    IMAGE_CACHE_MODE,
    isImageCachePolicyActive,
} from "@artgod/shared/media/token-image-cache";
import { TOKEN_IMAGE_CACHE_REFRESH_REASON } from "@artgod/shared/media/token-image-cache-jobs";

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
    imageCachePolicy: {
        selectedSource: CollectionCustomizationSourceKind;
        userConfig: ImageCachePolicyConfig;
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
            getImageCachePolicyState(params: {
                chainId: number;
                collectionId: number;
            }): CollectionCustomization["imageCachePolicy"];
            updateImageCachePolicyState(params: {
                chainId: number;
                collectionId: number;
                selectedSource: CollectionCustomizationSourceKind;
                userConfig: ImageCachePolicyConfig;
            }): CollectionCustomization["imageCachePolicy"];
        },
        readonly imageCachePolicyTransitionPort: {
            deleteCollectionImageCache(input: {
                chainId: number;
                collectionId: number;
            }): Promise<void> | void;
            publishCollectionImageCacheRefresh(input: {
                chainId: number;
                collectionId: number;
                requestedMaxDimension: number | null;
                imageCacheMode: ImageCachePolicyConfig["imageCacheMode"];
                reason: typeof TOKEN_IMAGE_CACHE_REFRESH_REASON.PolicyRefresh;
            }): Promise<void> | void;
        },
    ) {}

    async updateCollectionCustomization(
        input: UpdateCollectionCustomizationInput,
    ): Promise<UpdateCollectionCustomizationOutput> {
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
        const previousImageCachePolicy =
            this.customizationWritePort.getImageCachePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
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
        const imageCachePolicy =
            this.customizationWritePort.updateImageCachePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                selectedSource: input.imageCachePolicy.selectedSource,
                userConfig: input.imageCachePolicy.userConfig,
            });

        await this.applyImageCachePolicyTransition({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            previous: previousImageCachePolicy.effectiveConfig,
            next: imageCachePolicy.effectiveConfig,
        });

        return {
            chain,
            collection,
            customization: {
                traitFilterPresentation,
                tokenCardTraitSummaryTemplate,
                activityRowTraitSummaryTemplate,
                imageCachePolicy,
            },
        };
    }

    private async applyImageCachePolicyTransition(input: {
        chainId: number;
        collectionId: number;
        previous: ImageCachePolicyConfig;
        next: ImageCachePolicyConfig;
    }): Promise<void> {
        if (input.next.imageCacheMode === IMAGE_CACHE_MODE.Off) {
            if (isImageCachePolicyActive(input.previous)) {
                await this.imageCachePolicyTransitionPort.deleteCollectionImageCache(
                    input,
                );
            }
            return;
        }

        if (!sameImageCachePolicy(input.previous, input.next)) {
            await this.imageCachePolicyTransitionPort.publishCollectionImageCacheRefresh(
                {
                    chainId: input.chainId,
                    collectionId: input.collectionId,
                    requestedMaxDimension: input.next.maxDimension,
                    imageCacheMode: input.next.imageCacheMode,
                    reason: TOKEN_IMAGE_CACHE_REFRESH_REASON.PolicyRefresh,
                },
            );
        }
    }
}

function sameImageCachePolicy(
    left: ImageCachePolicyConfig,
    right: ImageCachePolicyConfig,
): boolean {
    return (
        left.imageCacheMode === right.imageCacheMode &&
        left.maxDimension === right.maxDimension
    );
}
