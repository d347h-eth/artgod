import type {
    ChainRecord,
    CollectionHolderPage,
    CollectionListItem,
} from "@artgod/shared/types/browse";

export type GetCollectionHoldersInput = {
    chainRef: string;
    collectionRef: string;
    limit: number;
    cursor?: string;
};

export type GetCollectionHoldersOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    holders: CollectionHolderPage;
};

export class GetCollectionHoldersUseCase {
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
            listCollectionHolders(params: {
                chainId: number;
                contractAddress: string;
                limit: number;
                cursor?: string;
            }): CollectionHolderPage;
        },
    ) {}

    getCollectionHolders(
        input: GetCollectionHoldersInput,
    ): GetCollectionHoldersOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionDetailReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const holders = this.collectionDetailReadPort.listCollectionHolders({
            chainId: chain.publicChainId,
            contractAddress: collection.address,
            limit: input.limit,
            cursor: input.cursor,
        });

        return {
            chain,
            collection,
            holders,
        };
    }
}
