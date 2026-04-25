import type { BidderJob } from "../../../domain/market/strategy/job.js";
import type { TradingJobStatus } from "@artgod/shared/types";

export type BiddingJobSourceRecord = {
    job: BidderJob;
    status: TradingJobStatus;
    revision: number;
};

// BiddingJobSource loads the authoritative enabled bidding jobs for runtime startup.
export interface BiddingJobSource {
    loadEnabledJobs(): Promise<BidderJob[]>;
    loadJobById(jobId: string): Promise<BiddingJobSourceRecord | null>;
    loadEnabledJobById(jobId: string): Promise<BidderJob | null>;
}
