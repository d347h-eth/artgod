import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type { BiddingBidBookLiveRefreshConfig } from "@artgod/shared/config/bidding";
import type { BlockExplorerConfig } from "@artgod/shared/config/block-explorer";

export type GetRuntimeConfigOutput = {
    integrations: {
        opensea: OpenSeaIntegrationStatus;
    };
    blockExplorer: BlockExplorerConfig;
    bidding: {
        trustOpenSeaSignedZoneTraitOffers: boolean;
        bidBookLiveRefresh: BiddingBidBookLiveRefreshConfig;
    };
};

export class GetRuntimeConfigUseCase {
    constructor(
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly blockExplorer: BlockExplorerConfig,
        private readonly biddingBidBookLiveRefresh: BiddingBidBookLiveRefreshConfig,
        private readonly trustOpenSeaSignedZoneTraitOffers: boolean,
    ) {}

    getConfig(): GetRuntimeConfigOutput {
        return {
            integrations: {
                opensea: this.openseaIntegration,
            },
            blockExplorer: this.blockExplorer,
            bidding: {
                trustOpenSeaSignedZoneTraitOffers:
                    this.trustOpenSeaSignedZoneTraitOffers,
                bidBookLiveRefresh: this.biddingBidBookLiveRefresh,
            },
        };
    }
}
