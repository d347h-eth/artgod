import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { assertBidScopeSupportsOwnStateFilter } from "@artgod/shared/trading/bid-book-own-state";
import type {
    CollectionBiddingBidBookOwnershipFilter,
    CollectionBiddingBidBookOwnStateFilter,
    CollectionBiddingBidScopeFilter,
} from "@artgod/shared/types";

// Rejects private identity/state selections that their read context or scope cannot answer.
export function assertBiddingBidBookFiltersAllowed(params: {
    includeOwnJobContext: boolean;
    scopeFilter: CollectionBiddingBidScopeFilter;
    makerAddress?: string | null;
    ownershipFilter?: CollectionBiddingBidBookOwnershipFilter | null;
    ownStateFilter?: CollectionBiddingBidBookOwnStateFilter | null;
}): void {
    if (params.makerAddress?.trim() && params.ownershipFilter) {
        throw new ReadModelBadRequestError(
            "Maker and ownership filters cannot be combined",
        );
    }
    if (
        (params.ownershipFilter || params.ownStateFilter) &&
        !params.includeOwnJobContext
    ) {
        throw new ReadModelBadRequestError(
            "Own bids are unavailable in public bid-book reads",
        );
    }
    if (params.ownStateFilter) {
        assertBidScopeSupportsOwnStateFilter(params.scopeFilter);
    }
}
