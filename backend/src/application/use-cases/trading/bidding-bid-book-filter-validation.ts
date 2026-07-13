import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { CollectionBiddingBidBookOwnershipFilter } from "@artgod/shared/types";

// Rejects ownership queries that cannot be answered without conflating local intent and marketplace identity.
export function assertBiddingBidBookFiltersAllowed(params: {
    includeOwnJobContext: boolean;
    makerAddress?: string | null;
    ownershipFilter?: CollectionBiddingBidBookOwnershipFilter | null;
}): void {
    if (params.makerAddress?.trim() && params.ownershipFilter) {
        throw new ReadModelBadRequestError(
            "Maker and ownership filters cannot be combined",
        );
    }
    if (params.ownershipFilter && !params.includeOwnJobContext) {
        throw new ReadModelBadRequestError(
            "Own bids are unavailable in public bid-book reads",
        );
    }
}
