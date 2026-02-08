import { describe, expect, it } from "vitest";
import {
    buildMetadataStatsRecomputeJob,
    METADATA_STATS_DEDUPE_BUCKET_MS,
} from "../src/application/metadata/stats-recompute.js";

describe("metadata stats recompute jobs", () => {
    it("schedules job at bucket end (trailing edge)", () => {
        const now = 10_005;
        const job = buildMetadataStatsRecomputeJob(
            {
                chainId: 1,
                contract: "0xabc0000000000000000000000000000000000000",
                reason: "metadata-refresh",
                sourceJobId: "source-1",
            },
            "trace-1",
            now,
        );

        expect(job.scheduledAt).toBe(20_000);
        expect(job.scheduledAt).toBeGreaterThan(now);
    });

    it("produces same jobId inside one bucket and different jobId across buckets", () => {
        const payload = {
            chainId: 1,
            contract: "0xabc0000000000000000000000000000000000000",
            reason: "metadata-refresh" as const,
            sourceJobId: "source-1",
        };

        const jobA = buildMetadataStatsRecomputeJob(payload, "trace-1", 10_100);
        const jobB = buildMetadataStatsRecomputeJob(payload, "trace-1", 19_999);
        const jobC = buildMetadataStatsRecomputeJob(
            payload,
            "trace-1",
            10_100 + METADATA_STATS_DEDUPE_BUCKET_MS,
        );

        expect(jobA.jobId).toBe(jobB.jobId);
        expect(jobA.jobId).not.toBe(jobC.jobId);
    });
});
