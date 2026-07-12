import type {
    ChainRecord,
    CollectionListItem,
    TokenMediaPreview,
    TokenMediaState,
} from "@artgod/shared/types/browse";
import {
    COLLECTION_MEDIA_MODES,
    type CollectionMediaPreferenceValue,
} from "@artgod/shared/extensions";
import {
    COLLECTION_MEDIA_PURPOSE,
    type MediaPurposePolicyFeatureState,
} from "@artgod/shared/types";
import { applyMediaPurposePolicyToTokenMedia } from "./media-purpose-policy.js";

type MaybePromise<T> = T | Promise<T>;

export type GetTokenPreviewInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    mediaMode?: string;
    mediaPreference?: CollectionMediaPreferenceValue;
    mediaVariant?: string;
};

export type TokenPreview = TokenMediaPreview;

export type GetTokenPreviewOutput = {
    media: TokenMediaState;
    token: TokenPreview;
};

export type GetTokenPreviewPort = {
    getTokenPreview(
        input: GetTokenPreviewInput,
    ): GetTokenPreviewOutput | Promise<GetTokenPreviewOutput>;
};

type CollectionDetailReadPort = {
    resolveCollectionRef(
        chainId: number,
        collectionRef: string,
    ): CollectionListItem;
    getCollectionTokenPreviewPresentation(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: string;
        mediaPreference?: CollectionMediaPreferenceValue;
        mediaVariant?: string;
    }): MaybePromise<{
        media: TokenMediaState;
        token: TokenMediaPreview;
    }>;
};

export class GetTokenPreviewUseCase implements GetTokenPreviewPort {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionDetailReadPort: CollectionDetailReadPort,
        readonly customizationReadPort: {
            getMediaPurposePolicyState(params: {
                chainId: number;
                collectionId: number;
            }): MediaPurposePolicyFeatureState;
        },
    ) {}

    async getTokenPreview(
        input: GetTokenPreviewInput,
    ): Promise<GetTokenPreviewOutput> {
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
            await this.collectionDetailReadPort.getCollectionTokenPreviewPresentation(
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
                      purpose: COLLECTION_MEDIA_PURPOSE.FullscreenPreview,
                  })
                : token;

        return {
            media,
            token: {
                tokenId: presentedToken.tokenId,
                image: presentedToken.image,
                animationUrl: presentedToken.animationUrl,
            },
        };
    }
}
