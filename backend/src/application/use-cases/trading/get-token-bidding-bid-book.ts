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
        const { traitContext } = resolveTraitScope(
            this.collectionReadPort,
            collection,
            input,
            input.tokenRef,
        );
        // Verify the token and reuse its normalized traits for applicability checks.
        const token = this.collectionReadPort.getCanonicalTokenTraits(
            chain.publicChainId,
            collection.collectionId,
            input.tokenRef,
            traitContext,
        );
        // Read bids that apply to this token across token, collection, trait, and token-set scopes.
        const bidBook = this.bidBookRepositoryPort.listTokenBidBook({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            tokenTraits: token.traits.map((trait) => ({
                type: trait.key,
                value: trait.value,
            })),
            includeOwnJobContext: input.includeOwnJobContext,
        });

        return {
            chain,
            collection,
            tokenId: token.tokenId,
            bidBook: mapPersistedBidBookToView(bidBook),
        };
    }
}
