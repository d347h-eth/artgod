import { MarketEvent } from "../../../../../domain/market/event.js";
import { biddingLog } from "../../../../../utils/bidding-log.js";
import { BidderRefreshPort } from "../../../bidding/bidder.js";
import { EventCallback, WrappingFn } from "../pipeline.js";

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
                    const message =
                        error instanceof Error ? error.message : String(error);
                    biddingLog.error(
                        `[BidderRefresh] Failed to refresh jobs for ${marketEvent.getCollectionSlug()}: ${message}`,
                    );
                }

                await callback(marketEvent);
            };
        };
    }
}
