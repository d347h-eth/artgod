import type {
    ChainRecord,
    CollectionMediaState,
    CollectionListItem,
    TokenBrowserStatus,
    TokenCursorPage,
    TraitFacet,
    TraitFilter,
} from "@artgod/shared/types/browse";

export type GetCollectionDetailInput = {
    chainRef: string;
    collectionRef: string;
    tokenStatus: TokenBrowserStatus;
    limit: number;
    cursor?: string;
    traits: TraitFilter[];
    owner?: string;
    mediaMode?: string;
};

export type GetCollectionDetailOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    traits: {
        selected: TraitFilter[];
        facets: TraitFacet[];
    };
    media: CollectionMediaState;
    tokens: TokenCursorPage;
};

export class GetCollectionDetailUseCase {
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
            listCollectionTokens(params: {
                chainId: number;
                collectionId: number;
                tokenStatus: TokenBrowserStatus;
                limit: number;
                cursor?: string;
                traitFilters?: TraitFilter[];
                owner?: string;
                mediaMode?: string;
            }): TokenCursorPage;
            listCollectionTraitFacets(
                chainId: number,
                collectionId: number,
                owner?: string,
            ): TraitFacet[];
            getCollectionMediaState(params: {
                chainId: number;
                collectionId: number;
                mediaMode?: string;
            }): CollectionMediaState;
        },
    ) {}

    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): GetCollectionDetailOutput {
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

        const tokens = this.collectionDetailReadPort.listCollectionTokens({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenStatus: input.tokenStatus,
            limit: input.limit,
            cursor: input.cursor,
            traitFilters: input.traits,
            owner: input.owner,
            mediaMode: media.selectedMode,
        });

        const facets = this.collectionDetailReadPort.listCollectionTraitFacets(
            chain.publicChainId,
            collection.collectionId,
            input.owner,
        );

        return {
            chain,
            collection,
            traits: {
                selected: input.traits,
                facets,
            },
            media,
            tokens,
        };
    }
}
