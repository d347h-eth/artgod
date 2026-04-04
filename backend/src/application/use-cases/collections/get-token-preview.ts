import type {
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

export type GetTokenPreviewInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    mediaMode?: string;
};

export type TokenPreview = TokenMediaPreview;

export type GetTokenPreviewOutput = {
    media: CollectionMediaState;
    token: TokenPreview;
};

export type GetTokenPreviewPort = {
    getTokenPreview(
        input: GetTokenPreviewInput,
    ): GetTokenPreviewOutput | Promise<GetTokenPreviewOutput>;
};

type CollectionDetailReadPort = {
    resolveCollectionRef(chainId: number, collectionRef: string): CollectionListItem;
    getCollectionTokenPreview(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        mediaMode?: string;
    }): TokenMediaPreview;
    getCollectionMediaState(params: {
        chainId: number;
        collectionId: number;
        mediaMode?: string;
    }): CollectionMediaState;
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
    ) {}

    getTokenPreview(input: GetTokenPreviewInput): GetTokenPreviewOutput {
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
        const token = this.collectionDetailReadPort.getCollectionTokenPreview({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
            mediaMode: media.selectedMode,
        });

        return {
            media,
            token: {
                tokenId: token.tokenId,
                image: token.image,
                animationUrl: token.animationUrl,
            },
        };
    }
}
