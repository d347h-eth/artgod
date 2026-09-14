import { beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type NatsConnection } from "nats";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobStreamMaintenanceProbeSubject,
    resolveNatsJobStreamName,
} from "@artgod/shared/queue/nats-job-stream";
import { NatsJobStreamMaintenanceAdapter } from "../src/infra/queue/nats-job-stream-maintenance.js";

import { planAcknowledgedJobStreamCleanup } from "../src/application/queue/maintain-nats-job-stream.js";
import { snapshot } from "./fixtures/nats-job-stream.js";

const TEST_STREAM_PREFIX = "test";
const TEST_NATS_URL = "nats://127.0.0.1:42720";

vi.mock("nats", async (importOriginal) => ({
    ...(await importOriginal<typeof import("nats")>()),
    connect: vi.fn(),
}));

// These fixtures assert JetStream's wire error codes independently of the adapter.
const RESOURCE_API_ERRORS = [
    { code: 503, err_code: 10023, description: "insufficient resources" },
    {
        code: 500,
        err_code: 10047,
        description: "insufficient storage resources available",
    },
];

beforeEach(() => {
    vi.mocked(connect).mockReset();
});

describe("NatsJobStreamMaintenanceAdapter", () => {
    it.each(RESOURCE_API_ERRORS)(
        "recognizes the explicit resource error $err_code",
        async (apiError) => {
            const error = resourceError(apiError);
            const adapter = adapterWithProbe(error);

            await expect(adapter.probeWritable()).resolves.toEqual({
                writable: false,
                resourceLimited: true,
                error: error.message,
            });
        },
    );

    it("does not classify a bare 503 as a resource limit", async () => {
        const adapter = adapterWithProbe(
            Object.assign(new Error("503"), { code: "503" }),
        );
        await expect(adapter.probeWritable()).resolves.toEqual({
            writable: false,
            resourceLimited: false,
            error: "503",
        });
    });

    it("does not classify a service-unavailable API error as a resource limit", async () => {
        const adapter = adapterWithProbe(
            Object.assign(new Error("503"), {
                code: "503",
                api_error: {
                    code: 503,
                    err_code: 10008,
                    description: "JetStream system temporarily unavailable",
                },
            }),
        );

        expect(await adapter.probeWritable()).toMatchObject({
            writable: false,
            resourceLimited: false,
        });
    });

    it("does not authorize resource recovery when only probe deletion fails", async () => {
        const error = resourceError(RESOURCE_API_ERRORS[0]);
        const adapter = adapterWithProbe(error);
        const sequence = 7;
        const deleteMessage = vi.fn().mockRejectedValue(error);
        Object.assign(adapter, {
            jetStream: {
                publish: vi.fn().mockResolvedValue({ seq: sequence }),
            },
            manager: { streams: { deleteMessage } },
        });

        expect(await adapter.probeWritable()).toMatchObject({
            writable: false,
            resourceLimited: false,
        });
        expect(deleteMessage).toHaveBeenCalledWith(
            resolveNatsJobStreamName(TEST_STREAM_PREFIX),
            sequence,
            false,
        );
    });

    it("closes the connection when manager initialization fails", async () => {
        const connection = connectionFixture();
        const error = new Error("JetStream is unavailable");
        connection.jetstreamManager.mockRejectedValue(error);

        await expect(
            NatsJobStreamMaintenanceAdapter.connect({
                natsUrl: TEST_NATS_URL,
                streamPrefix: TEST_STREAM_PREFIX,
            }),
        ).rejects.toBe(error);

        expect(connection.close).toHaveBeenCalledOnce();
    });

    it("closes the connection when client initialization throws", async () => {
        const connection = connectionFixture();
        const error = new Error("Invalid JetStream client configuration");
        connection.jetstream.mockImplementation(() => {
            throw error;
        });

        await expect(
            NatsJobStreamMaintenanceAdapter.connect({
                natsUrl: TEST_NATS_URL,
                streamPrefix: TEST_STREAM_PREFIX,
            }),
        ).rejects.toBe(error);

        expect(connection.close).toHaveBeenCalledOnce();
        expect(connection.jetstreamManager).not.toHaveBeenCalled();
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

describe("acknowledged cleanup adapter", () => {
    function cleanupFixture() {
        const state = snapshot();
        const cleanup = planAcknowledgedJobStreamCleanup(state)[0]!;
        const adapter = Object.create(
            NatsJobStreamMaintenanceAdapter.prototype,
        ) as NatsJobStreamMaintenanceAdapter;
        const purge = vi.fn().mockResolvedValue({ success: true, purged: 20 });
        Object.assign(adapter, {
            streamName: resolveNatsJobStreamName(TEST_STREAM_PREFIX),
            streamPrefix: TEST_STREAM_PREFIX,
            manager: { streams: { purge } },
        });
        vi.spyOn(adapter, "inspect").mockImplementation(async () => state);
        return { adapter, state, cleanup, purge };
    }

    it("sends an exact subject and exclusive ACK cutoff, never an unfiltered purge", async () => {
        const { adapter, cleanup, purge } = cleanupFixture();
        expect(await adapter.removeAcknowledged(cleanup)).toBe(20);
        expect(purge).toHaveBeenCalledExactlyOnceWith(
            resolveNatsJobStreamName(TEST_STREAM_PREFIX),
            {
                filter: cleanup.subject,
                seq: cleanup.throughSequence + 1,
            },
        );
    });

    it.each([
        "recreated-stream",
        "recreated-consumer",
        "in-flight",
        "changed-floor",
        "changed-scope",
    ])("rejects changed evidence: %s", async (change) => {
        const { adapter, state, cleanup, purge } = cleanupFixture();
        // Preserve the planned evidence while independently changing the inspected state.
        const planned = structuredClone(cleanup);
        if (change === "recreated-stream")
            state.stream!.created = "2026-09-15T00:00:00Z";
        if (change === "recreated-consumer")
            state.consumers[0]!.created = "2026-09-15T00:00:00Z";
        if (change === "in-flight") state.consumers[0]!.ackPending = 1;
        if (change === "changed-floor")
            state.consumers[0]!.ackFloorStreamSequence--;
        if (change === "changed-scope") planned.subject = ">";
        await expect(adapter.removeAcknowledged(planned)).rejects.toThrow(
            "evidence changed",
        );
        expect(purge).not.toHaveBeenCalled();
    });

    it("does not broaden cleanup when NATS rejects the scoped request", async () => {
        const { adapter, cleanup, purge } = cleanupFixture();
        purge.mockResolvedValue({ success: false, purged: 0 });
        await expect(adapter.removeAcknowledged(cleanup)).rejects.toThrow(
            "cleanup failed",
        );
        expect(purge).toHaveBeenCalledTimes(1);
    });
});

function connectionFixture() {
    const connection = {
        jetstream: vi.fn().mockReturnValue({}),
        jetstreamManager: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(connect).mockResolvedValue(
        connection as unknown as NatsConnection,
    );
    return connection;
}

function resourceError(apiError: (typeof RESOURCE_API_ERRORS)[number]) {
    return Object.assign(new Error(String(apiError.code)), {
        code: String(apiError.code),
        api_error: apiError,
    });
}

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
