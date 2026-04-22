import { MarketEvent } from "../../../../../domain/market/event.js";
import {
    CollectionOfferRefreshPort,
} from "../../../bidding/collection-offer-snapshot-service.js";
import { biddingLog } from "../../../../../utils/bidding-log.js";
import { EventCallback, WrappingFn } from "../pipeline.js";

// CollectionOfferSnapshotRefresh blocks hot refresh on an awaited snapshot refresh when the event warrants it.
export class CollectionOfferSnapshotRefresh {
    constructor(
        private readonly name: string,
        private readonly refreshPort: CollectionOfferRefreshPort,
        private readonly getRefreshReason: (
            marketEvent: MarketEvent,
        ) => string | null,
    ) {}

    public getName(): string {
        return this.name;
    }

    public getWrappingFn(): WrappingFn {
        return (callback: EventCallback): EventCallback => {
            return async (marketEvent: MarketEvent) => {
                try {
                    const refreshReason = this.getRefreshReason(marketEvent);
                    if (refreshReason) {
                        // Refresh the authoritative collection snapshot before bidder hot refresh uses snapshot-backed state.
                        biddingLog.debug(
                            `[CollectionOfferSnapshotRefresh] Triggering CollectionOfferSnapshotService for ${marketEvent.getCollectionSlug()}: ${refreshReason}`,
                        );
                        await this.refreshPort.refreshAndWait(
                            marketEvent.getCollectionSlug(),
                            refreshReason,
                            { respectTtl: true },
                        );
                    }
                } catch (error: unknown) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    biddingLog.error(
                        `[CollectionOfferSnapshotRefresh] Failed to handle refresh signal for ${marketEvent.getCollectionSlug()}: ${message}`,
                    );
                }

                await callback(marketEvent);
            };
        };
    }
}
