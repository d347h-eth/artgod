import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type { TokenDetail } from "@artgod/shared/types/browse";
import type {
    BiddingBidBookRepositoryPort,
    GetTokenBiddingBidBookOutput,
} from "./bidding-bid-book.js";
import { mapPersistedBidBookToView } from "./bidding-bid-book.js";
export type { GetTokenBiddingBidBookOutput } from "./bidding-bid-book.js";

export type GetTokenBiddingBidBookInput = {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
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
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
            getCollectionTokenDetail(params: {
                chainId: number;
                collectionId: number;
                tokenId: string;
            }): TokenDetail;
        },
        readonly bidBookRepositoryPort: BiddingBidBookRepositoryPort,
    ) {}

    getTokenBiddingBidBook(
        input: GetTokenBiddingBidBookInput,
    ): GetTokenBiddingBidBookOutput {
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
        // Verify the token and reuse its normalized traits for applicability checks.
        const token = this.collectionReadPort.getCollectionTokenDetail({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: input.tokenRef,
        });
        // Read bids that apply to this token across token, collection, trait, and token-set scopes.
        const bidBook = this.bidBookRepositoryPort.listTokenBidBook({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            tokenId: token.tokenId,
            tokenTraits: token.attributes.map((trait) => ({
                type: trait.key,
                value: trait.value,
            })),
        });

        return {
            chain,
            collection,
            tokenId: token.tokenId,
            bidBook: mapPersistedBidBookToView(bidBook),
        };
    }
}
