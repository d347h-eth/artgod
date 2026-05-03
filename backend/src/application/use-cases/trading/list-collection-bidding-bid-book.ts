import type { ChainRecord, CollectionListItem } from "@artgod/shared/types";
import type {
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import { applyTraitFilterPresentationToFacets } from "@artgod/shared/read-models/collections";
import type {
    BiddingBidBookRepositoryPort,
    CollectionBiddingBidScopeFilter,
    CollectionBiddingTraitFilterJoinMode,
    ListCollectionBiddingBidBookOutput,
} from "./bidding-bid-book.js";
import { mapPersistedBidBookToView } from "./bidding-bid-book.js";
export type { ListCollectionBiddingBidBookOutput } from "./bidding-bid-book.js";

export type ListCollectionBiddingBidBookInput = {
    chainRef: string;
    collectionRef: string;
    scopeFilter: CollectionBiddingBidScopeFilter;
    traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
    traits: TraitFilter[];
    traitRanges: TraitRangeFilter[];
};

export class ListCollectionBiddingBidBookUseCase {
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
            listCollectionTraitFacets(
                chainId: number,
                collectionId: number,
            ): TraitFacet[];
        },
        readonly customizationReadPort: {
            getTraitFilterPresentationState(params: {
                chainId: number;
                collectionId: number;
                availableTraitKeys?: string[];
            }): {
                effectiveConfig: {
                    rangeKeys: string[];
                };
            };
        },
        readonly bidBookRepositoryPort: BiddingBidBookRepositoryPort,
    ) {}

    listCollectionBiddingBidBook(
        input: ListCollectionBiddingBidBookInput,
    ): ListCollectionBiddingBidBookOutput {
        // Resolve the requested chain before reading collection-scoped bid data.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection so bid-book source selection uses canonical collection ids.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        // Load facets for the bidding page filter panel without fetching token cards.
        const rawFacets = this.collectionReadPort.listCollectionTraitFacets(
            chain.publicChainId,
            collection.collectionId,
        );
        const traitFilterPresentation =
            this.customizationReadPort.getTraitFilterPresentationState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                availableTraitKeys: rawFacets.map((facet) => facet.key),
            });
        const facets = applyTraitFilterPresentationToFacets({
            facets: rawFacets,
            config: traitFilterPresentation.effectiveConfig,
        });
        // Read the source-selected bid book: bot snapshot for enabled jobs, canonical orders otherwise.
        const bidBook = this.bidBookRepositoryPort.listCollectionBidBook({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            scopeFilter: input.scopeFilter,
            traitFilterJoinMode: input.traitFilterJoinMode,
            selectedTraits: input.traits,
            selectedTraitRanges: input.traitRanges,
        });

        return {
            chain,
            collection,
            scopeFilter: input.scopeFilter,
            traits: {
                selected: input.traits,
                selectedRanges: input.traitRanges,
                facets,
            },
            bidBook: mapPersistedBidBookToView(bidBook),
        };
    }
}
