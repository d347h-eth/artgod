import type { BidderJob } from "../../../domain/market/strategy/job.js";

// BiddingJobSource loads the authoritative enabled bidding jobs for runtime startup.
export interface BiddingJobSource {
    loadEnabledJobs(): Promise<BidderJob[]>;
}
