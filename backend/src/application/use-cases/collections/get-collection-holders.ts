import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
    wrapCatalogPage,
    unwrapCatalogCursor,
} from "./collection-views.js";
import type {
    ChainRecord,
    CollectionHolderPage,
    CollectionListItem,
} from "@artgod/shared/types/browse";

export type GetCollectionHoldersInput = CatalogRequest & {
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
        readonly collectionDetailReadPort: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            listCollectionHolders(params: {
                traitContext?: TraitReadContext;
                chainId: number;
                collectionId: number;
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
        const { traitContext } = resolveTraitScope(
            this.collectionDetailReadPort,
            collection,
            input,
        );
        const holders = this.collectionDetailReadPort.listCollectionHolders({
            traitContext,
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            limit: input.limit,
            cursor: unwrapCatalogCursor(input.cursor, traitContext),
        });

        return {
            chain,
            collection,
            holders: wrapCatalogPage(holders, traitContext),
        };
    }
}
