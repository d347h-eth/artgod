import type {
    ChainRecord,
    CollectionStatus,
    CollectionListItem,
    CursorPage,
} from "@artgod/shared/types/browse";

export type ListCollectionsInput = {
    chainRef: string;
    status?: CollectionStatus;
    limit: number;
    cursor?: string;
};

export type ListCollectionsOutput = {
    chain: ChainRecord;
    filters: {
        status?: CollectionStatus;
    };
    page: CursorPage<CollectionListItem>;
};

export class ListCollectionsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionsReadPort: {
            listCollections(params: {
                chainId: number;
                status?: CollectionStatus;
                limit: number;
                cursor?: string;
            }): CursorPage<CollectionListItem>;
        },
    ) {}

    listCollections(input: ListCollectionsInput): ListCollectionsOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );

        const page = this.collectionsReadPort.listCollections({
            chainId: chain.publicChainId,
            status: input.status,
            limit: input.limit,
            cursor: input.cursor,
        });

        return {
            chain,
            filters: { status: input.status },
            page,
        };
    }
}
