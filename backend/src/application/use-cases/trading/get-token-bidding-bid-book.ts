import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
} from "../collections/collection-views.js";
import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import type { TraitFilter } from "@artgod/shared/types/browse";
import type {
    BiddingBidBookRepositoryPort,
    GetTokenBiddingBidBookOutput,
} from "./bidding-bid-book.js";
import { mapPersistedBidBookToView } from "./bidding-bid-book.js";
export type { GetTokenBiddingBidBookOutput } from "./bidding-bid-book.js";

export type GetTokenBiddingBidBookInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
    includeOwnJobContext: boolean;
};

export class GetTokenBiddingBidBookUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            getCanonicalTokenTraits(
                chainId: number,
                collectionId: number,
                tokenId: string,
                traitContext?: TraitReadContext,
            ): { tokenId: string; traits: TraitFilter[] };
        },
        readonly bidBookRepositoryPort: BiddingBidBookRepositoryPort,
    ) {}

    async getTokenBiddingBidBook(
        input: GetTokenBiddingBidBookInput,
    ): Promise<GetTokenBiddingBidBookOutput> {
        // Resolve the requested chain before reading token-scoped bid data.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection so bid-book source selection uses canonical collection ids.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        const tokenId = input.tokenRef.trim();
        const { traitContext } = resolveTraitScope(
            this.collectionReadPort,
            collection,
            input,
            tokenId,
        );
        const bidBook = this.bidBookRepositoryPort.listTokenBidBook({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId,
            readCanonicalTraits: () =>
                this.collectionReadPort
                    .getCanonicalTokenTraits(
                        chain.publicChainId,
                        collection.collectionId,
                        tokenId,
                        traitContext,
                    )
                    .traits.map(({ key, value }) => ({ type: key, value })),
            includeOwnJobContext: input.includeOwnJobContext,
        });

        return {
            chain,
            collection,
            tokenId,
            bidBook: mapPersistedBidBookToView(bidBook),
        };
    }
}
