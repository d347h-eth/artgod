import { describe, expect, it, vi } from "vitest";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobStreamMaintenanceProbeSubject,
    resolveNatsJobStreamName,
} from "@artgod/shared/queue/nats-job-stream";
import { NatsJobStreamMaintenanceAdapter } from "../src/infra/queue/nats-job-stream-maintenance.js";

const TEST_STREAM_PREFIX = "test";

describe("NatsJobStreamMaintenanceAdapter", () => {
    it("classifies the observed JetStream 503 as a storage recovery signal", async () => {
        const adapter = adapterWithProbe(
            Object.assign(new Error("resource limit"), { code: "503" }),
        );

        await expect(adapter.probeWritable()).resolves.toEqual({
            writable: false,
            resourceLimited: true,
            error: "resource limit",
        });
    });

    it("accepts a timed-out update when the installed policy was applied", async () => {
        const info = vi
            .fn()
            .mockResolvedValueOnce(
                streamInfo(NATS_JOB_STREAM_MAX_AGE_NANOS + 1),
            )
            .mockResolvedValueOnce(streamInfo(NATS_JOB_STREAM_MAX_AGE_NANOS));
        const update = vi.fn().mockRejectedValue({ code: "TIMEOUT" });
        const adapter = adapterWithManager({ info, update });

        await expect(
            adapter.reconcileMaxAge(NATS_JOB_STREAM_MAX_AGE_NANOS),
        ).resolves.toBeUndefined();

        expect(update).toHaveBeenCalledWith(
            resolveNatsJobStreamName(TEST_STREAM_PREFIX),
            { max_age: NATS_JOB_STREAM_MAX_AGE_NANOS },
        );
        expect(info).toHaveBeenCalledTimes(2);
    });

    it("preserves a timeout when the policy was not applied", async () => {
        const timeout = { code: "TIMEOUT" };
        const info = vi
            .fn()
            .mockResolvedValue(streamInfo(NATS_JOB_STREAM_MAX_AGE_NANOS + 1));
        const adapter = adapterWithManager({
            info,
            update: vi.fn().mockRejectedValue(timeout),
        });

        await expect(
            adapter.reconcileMaxAge(NATS_JOB_STREAM_MAX_AGE_NANOS),
        ).rejects.toBe(timeout);
    });
});

function adapterWithManager(input: {
    info: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
}): NatsJobStreamMaintenanceAdapter {
    const adapter = Object.create(
        NatsJobStreamMaintenanceAdapter.prototype,
    ) as NatsJobStreamMaintenanceAdapter;
    Object.assign(adapter, {
        streamName: resolveNatsJobStreamName(TEST_STREAM_PREFIX),
        manager: { streams: input },
    });
    return adapter;
}

function adapterWithProbe(error: Error & { code: string }) {
    const adapter = Object.create(
        NatsJobStreamMaintenanceAdapter.prototype,
    ) as NatsJobStreamMaintenanceAdapter;
    Object.assign(adapter, {
        streamName: resolveNatsJobStreamName(TEST_STREAM_PREFIX),
        probeSubject:
            resolveNatsJobStreamMaintenanceProbeSubject(TEST_STREAM_PREFIX),
        jetStream: { publish: vi.fn().mockRejectedValue(error) },
        manager: { streams: {} },
    });
    return adapter;
}

function streamInfo(maxAgeNanos: number) {
    return { config: { max_age: maxAgeNanos } };
}
