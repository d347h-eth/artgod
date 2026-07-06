import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type { BiddingBidBookLiveRefreshConfig } from "@artgod/shared/config/bidding";
import type { TransactionExplorerConfig } from "@artgod/shared/config/transaction-explorer";

export type GetRuntimeConfigOutput = {
    integrations: {
        opensea: OpenSeaIntegrationStatus;
    };
    transactionExplorer: TransactionExplorerConfig;
    bidding: {
        bidBookLiveRefresh: BiddingBidBookLiveRefreshConfig;
    };
};

export class GetRuntimeConfigUseCase {
    constructor(
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly transactionExplorer: TransactionExplorerConfig,
        private readonly biddingBidBookLiveRefresh: BiddingBidBookLiveRefreshConfig,
    ) {}

    getConfig(): GetRuntimeConfigOutput {
        return {
            integrations: {
                opensea: this.openseaIntegration,
            },
            transactionExplorer: this.transactionExplorer,
            bidding: {
                bidBookLiveRefresh: this.biddingBidBookLiveRefresh,
            },
        };
    }
}
