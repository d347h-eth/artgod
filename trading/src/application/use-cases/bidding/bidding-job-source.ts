import type { BidderJob } from "../../../domain/market/strategy/job.js";
import type { TradingJobStatus } from "@artgod/shared/types";

export type BiddingJobSourceRecord = {
    job: BidderJob;
    status: TradingJobStatus;
    revision: number;
    // A tracked offer belongs to the spec revision that placed it, independently of later edits.
    activeOrderJobRevision: number | null;
};

// BiddingJobSource admits enabled declarations only within this process's immutable mandate.
export interface BiddingJobSource {
    // Startup, watches, snapshots and scans all consume the same authorized job set.
    loadEnabledJobs(): Promise<BidderJob[]>;
    // Explicit cancellation can load any declaration, independently of placement authority.
    loadJobById(jobId: string): Promise<BiddingJobSourceRecord | null>;
    // Create/update commands must use this admission check before market preparation.
    loadEnabledJobById(jobId: string): Promise<BidderJob | null>;
}
