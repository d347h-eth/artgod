import type {
    ChainRecord,
    CollectionListItem,
    CollectionStatus,
    CursorPage,
    TokenCursorPage,
    TraitFacet,
    TraitFilter,
} from "@artgod/shared/types/browse";

export type ListCollectionsPortParams = {
    chainId: number;
    status?: CollectionStatus;
    limit: number;
    cursor?: string;
};

export type ListCollectionTokensPortParams = {
    chainId: number;
    contractAddress: string;
    limit: number;
    cursor?: string;
    traitFilters?: TraitFilter[];
};

export interface ChainsReadPort {
    getDefaultChain(defaultPublicChainId: number): ChainRecord;
    resolveChainRef(
        chainRef: string | undefined,
        defaultPublicChainId: number,
    ): ChainRecord;
}

export interface CollectionsReadPort {
    listCollections(
        params: ListCollectionsPortParams,
    ): CursorPage<CollectionListItem>;
    resolveCollectionRef(chainId: number, collectionRef: string): CollectionListItem;
    listCollectionTokens(params: ListCollectionTokensPortParams): TokenCursorPage;
    listCollectionTraitFacets(chainId: number, contractAddress: string): TraitFacet[];
}
