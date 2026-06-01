import { MarketEvent } from "../../../../../domain/market/event.js";
import {
    BIDDING_LOG_COMPONENT,
    createBiddingComponentLogger,
    toErrorLogFields,
} from "../../../../../utils/bidding-log.js";
import { BidderRefreshPort } from "../../../bidding/bidder.js";
import { EventCallback, WrappingFn } from "../pipeline.js";

const log = createBiddingComponentLogger(BIDDING_LOG_COMPONENT.BidderRefresh);

// BidderRefresh wires stream events into the bidder hot-refresh port.
export class BidderRefresh {
    constructor(
        private readonly name: string,
        private readonly refreshPort: BidderRefreshPort,
    ) {}

    public getName(): string {
        return this.name;
    }

    public getWrappingFn(): WrappingFn {
        return (callback: EventCallback): EventCallback => {
            return async (marketEvent: MarketEvent) => {
                try {
                    await this.refreshPort.refreshMatchingJobs(marketEvent);
                } catch (error: unknown) {
                    log.error("refreshMatchingJobsFailed", "Failed to refresh matching bidding jobs", {
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
