import type {
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenDetail,
} from "@artgod/shared/types/browse";

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
            }): TokenDetail;
            getCollectionMediaState(params: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
            }): CollectionMediaState;
        },
    ) {}

    getTokenDetail(input: GetTokenDetailInput): GetTokenDetailOutput {
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

        const token = this.collectionDetailReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
            mediaMode: media.selectedMode,
        });

        return {
            chain,
            collection,
            media,
            token,
        };
    }
}
