import { MarketEvent } from "../../../../../domain/market/event.js";
import {
    CollectionOfferRefreshPort,
} from "../../../bidding/collection-offer-snapshot-service.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../../../utils/bidding-log.js";
import { EventCallback, WrappingFn } from "../pipeline.js";

const log = createBiddingComponentLogger(
    BIDDING_LOG_COMPONENT.CollectionOfferSnapshotRefresh,
);

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
                        log.debug(
                            "refreshTriggered",
                            "Triggered collection offer snapshot refresh from market event",
                            {
                                collectionSlug: marketEvent.getCollectionSlug(),
                                eventType: marketEvent.getType(),
                                reason: refreshReason,
                            },
                        );
                        await this.refreshPort.refreshAndWait(
                            marketEvent.getCollectionSlug(),
                            refreshReason,
                            { respectTtl: true },
                        );
                    }
                } catch (error: unknown) {
                    log.error("refreshSignalFailed", "Failed to handle collection offer snapshot refresh signal", {
                        collectionSlug: marketEvent.getCollectionSlug(),
                        eventType: marketEvent.getType(),
                        ...toErrorLogFields(error),
                    });
                }

                await callback(marketEvent);
            };
        };
    }
}
