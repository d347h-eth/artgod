import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type { BiddingBidBookLiveRefreshConfig } from "@artgod/shared/config/bidding";

export type GetRuntimeConfigOutput = {
    integrations: {
        opensea: OpenSeaIntegrationStatus;
    };
    bidding: {
        bidBookLiveRefresh: BiddingBidBookLiveRefreshConfig;
    };
};

export class GetRuntimeConfigUseCase {
    constructor(
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly biddingBidBookLiveRefresh: BiddingBidBookLiveRefreshConfig,
    ) {}

    getConfig(): GetRuntimeConfigOutput {
        return {
            integrations: {
                opensea: this.openseaIntegration,
            },
            bidding: {
                bidBookLiveRefresh: this.biddingBidBookLiveRefresh,
            },
        };
    }
}
