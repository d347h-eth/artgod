import type {
    ChainRecord,
    CollectionListItem,
    TokenDetail,
    TokenMediaState,
} from "@artgod/shared/types/browse";
import {
    COLLECTION_MEDIA_MODES,
    type CollectionMediaPreferenceValue,
} from "@artgod/shared/extensions";
import {
    COLLECTION_MEDIA_PURPOSE,
    type MediaPurposePolicyFeatureState,
    type TraitFilterPresentationFeatureState,
} from "@artgod/shared/types";
import { applyMediaPurposePolicyToTokenMedia } from "./media-purpose-policy.js";

type MaybePromise<T> = T | Promise<T>;

export type GetTokenDetailInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
    mediaVariant?: string;
};

export type GetTokenDetailOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    media: TokenMediaState;
    token: TokenDetail;
    traitFilterPresentation: TraitFilterPresentationFeatureState;
};

export class GetTokenDetailUseCase {
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
            getCollectionTokenDetailPresentation(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
                mediaMode?: string;
                mediaPreference?: CollectionMediaPreferenceValue;
                mediaVariant?: string;
            }): MaybePromise<{
                media: TokenMediaState;
                token: TokenDetail;
            }>;
        },
        readonly customizationReadPort: {
            getTraitFilterPresentationState(params: {
                chainId: number;
                collectionId: number;
                availableTraitKeys?: string[];
            }): TraitFilterPresentationFeatureState;
            getMediaPurposePolicyState(params: {
                chainId: number;
                collectionId: number;
            }): MediaPurposePolicyFeatureState;
        },
    ) {}

    async getTokenDetail(
        input: GetTokenDetailInput,
    ): Promise<GetTokenDetailOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );

        const collection = this.collectionDetailReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );

        // Resolve media selection and token presentation against one extension-read context.
        const { media, token } =
            await this.collectionDetailReadPort.getCollectionTokenDetailPresentation(
                {
                    chainId: chain.publicChainId,
                    collectionId: collection.collectionId,
                    tokenId: input.tokenRef,
                    mediaMode: input.mediaMode,
                    mediaPreference: input.mediaPreference,
                    mediaVariant: input.mediaVariant,
                },
            );
        const mediaPurposePolicy =
            this.customizationReadPort.getMediaPurposePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            });
        const presentedToken =
            media.selectedMode === COLLECTION_MEDIA_MODES.Snapshot
                ? applyMediaPurposePolicyToTokenMedia({
                      token,
                      config: mediaPurposePolicy.effectiveConfig,
                      purpose: COLLECTION_MEDIA_PURPOSE.TokenDetail,
                  })
                : token;
        const traitFilterPresentation =
            this.customizationReadPort.getTraitFilterPresentationState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                availableTraitKeys: presentedToken.attributes.map(
                    (attribute) => attribute.key,
                ),
            });

        return {
            chain,
            collection,
            media,
            token: presentedToken,
            traitFilterPresentation,
        };
    }
}
