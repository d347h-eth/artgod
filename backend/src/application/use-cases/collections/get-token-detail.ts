import type {
    ChainRecord,
    CollectionListItem,
    TokenDetail,
} from "@artgod/shared/types/browse";

export type GetTokenDetailInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
};

export type GetTokenDetailOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
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
                contractAddress: string;
                tokenId: string;
            }): TokenDetail;
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

        const token = this.collectionDetailReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            contractAddress: collection.address,
            tokenId: input.tokenRef,
        });

        return {
            chain,
            collection,
            token,
        };
    }
}
