import { describe, expect, it } from "vitest";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobStreamMaintenanceProbeSubject,
    resolveNatsJobStreamName,
    resolveNatsJobStreamSubjectFilter,
    resolveNatsJobSubject,
    resolveNatsJobSubjectPrefix,
} from "./nats-job-stream.js";

describe("NATS jobs stream contract", () => {
    it("owns the exact 24-hour JetStream retention value", () => {
        expect(NATS_JOB_STREAM_MAX_AGE_NANOS).toBe(86_400_000_000_000);
    });

    it("resolves the installed stream and subject vocabulary", () => {
        expect(resolveNatsJobStreamName("artgod")).toBe("artgod-jobs");
        expect(resolveNatsJobSubjectPrefix("artgod")).toBe("artgod.jobs");
        expect(resolveNatsJobStreamSubjectFilter("artgod")).toBe(
            "artgod.jobs.>",
        );
        expect(resolveNatsJobSubject("artgod", "orders-domain")).toBe(
            "artgod.jobs.orders-domain",
        );
        expect(resolveNatsJobStreamMaintenanceProbeSubject("artgod")).toBe(
            "artgod.jobs._maintenance_probe",
        );
    });
});
