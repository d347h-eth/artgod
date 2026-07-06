import type {
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenDetail,
} from "@artgod/shared/types/browse";
import { COLLECTION_MEDIA_MODES } from "@artgod/shared/extensions";
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
};

export type GetTokenDetailOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    media: CollectionMediaState;
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
            getCollectionTokenDetail(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
                mediaMode?: string;
            }): MaybePromise<TokenDetail>;
            getCollectionTokenMediaState(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
                mediaMode?: string;
            }): CollectionMediaState;
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

        const media = this.collectionDetailReadPort.getCollectionTokenMediaState({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
            mediaMode: input.mediaMode,
        });

        const token = await this.collectionDetailReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
            mediaMode: media.selectedMode,
        });
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
