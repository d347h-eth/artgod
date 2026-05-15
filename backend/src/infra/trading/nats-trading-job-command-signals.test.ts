import { strict as assert } from "node:assert";
import { beforeEach, describe, it, vi } from "vitest";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_JOB_SIGNAL_KIND,
    tradingBiddingJobsChangedSubject,
    tradingJobSignalStreamName,
    type TradingJobCommandRecord,
} from "@artgod/shared/types";

const natsMocks = vi.hoisted(() => {
    const publish = vi.fn();
    const streamInfo = vi.fn();
    const streamAdd = vi.fn();
    const drain = vi.fn();
    const connect = vi.fn();
    return {
        publish,
        streamInfo,
        streamAdd,
        drain,
        connect,
        JSONCodec: vi.fn(() => ({
            encode: (value: unknown) =>
                new TextEncoder().encode(JSON.stringify(value)),
        })),
    };
});

vi.mock("nats", () => ({
    JSONCodec: natsMocks.JSONCodec,
    RetentionPolicy: { Limits: "limits" },
    StorageType: { File: "file" },
    connect: natsMocks.connect,
}));

describe("NatsTradingJobCommandSignalPublisher", () => {
    beforeEach(() => {
        vi.resetModules();
        natsMocks.publish.mockReset();
        natsMocks.streamInfo.mockReset();
        natsMocks.streamAdd.mockReset();
        natsMocks.drain.mockReset();
        natsMocks.drain.mockResolvedValue(undefined);
        natsMocks.connect.mockReset();
        natsMocks.connect.mockResolvedValue({
            jetstream: () => ({
                publish: natsMocks.publish,
            }),
            jetstreamManager: async () => ({
                streams: {
                    info: natsMocks.streamInfo,
                    add: natsMocks.streamAdd,
                },
            }),
            drain: natsMocks.drain,
        });
    });

    it("does not connect when there are no commands to signal", async () => {
        const { NatsTradingJobCommandSignalPublisher } = await import(
            "./nats-trading-job-command-signals.js"
        );
        const publisher = new NatsTradingJobCommandSignalPublisher(
            "nats://127.0.0.1:4222",
            "artgod",
        );

        publisher.publishBiddingJobCommandsChanged([]);

        assert.equal(natsMocks.connect.mock.calls.length, 0);
    });

    it("ensures the stream and publishes compact bidding command wake-ups", async () => {
        natsMocks.streamInfo.mockRejectedValueOnce(new Error("missing"));
        const { NatsTradingJobCommandSignalPublisher } = await import(
            "./nats-trading-job-command-signals.js"
        );
        const publisher = new NatsTradingJobCommandSignalPublisher(
            "nats://127.0.0.1:4222",
            "artgod",
        );

        await (
            publisher as unknown as {
                publish(commands: TradingJobCommandRecord[]): Promise<void>;
            }
        ).publish([
            command({ commandId: 1, jobId: "job-a" }),
            command({ commandId: 2, jobId: "job-a" }),
            command({ commandId: 3, jobId: "job-b" }),
        ]);

        assert.deepEqual(natsMocks.streamAdd.mock.calls[0]?.[0], {
            name: tradingJobSignalStreamName("artgod"),
            subjects: [tradingBiddingJobsChangedSubject("artgod")],
            retention: "limits",
            storage: "file",
            max_age: 24 * 60 * 60 * 1_000_000_000,
        });
        const [subject, encoded, options] = natsMocks.publish.mock.calls[0] ?? [];
        assert.equal(subject, tradingBiddingJobsChangedSubject("artgod"));
        assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded)), {
            kind: TRADING_JOB_SIGNAL_KIND.BiddingJobsChanged,
            commandIds: [1, 2, 3],
            jobIds: ["job-a", "job-b"],
            publishedAt: JSON.parse(new TextDecoder().decode(encoded)).publishedAt,
        });
        assert.deepEqual(options, {
            msgID: "bidding-jobs-changed:1,2,3",
        });

        await publisher.close();
        assert.equal(natsMocks.drain.mock.calls.length, 1);
    });

    it("reuses an existing stream without adding it again", async () => {
        natsMocks.streamInfo.mockResolvedValueOnce({});
        const { NatsTradingJobCommandSignalPublisher } = await import(
            "./nats-trading-job-command-signals.js"
        );
        const publisher = new NatsTradingJobCommandSignalPublisher(
            "nats://127.0.0.1:4222",
            "artgod",
        );

        await (
            publisher as unknown as {
                publish(commands: TradingJobCommandRecord[]): Promise<void>;
            }
        ).publish([command({ commandId: 9, jobId: "job-a" })]);

        assert.equal(natsMocks.streamAdd.mock.calls.length, 0);
        assert.equal(natsMocks.publish.mock.calls.length, 1);
    });
});

function command(
    overrides: Partial<TradingJobCommandRecord>,
): TradingJobCommandRecord {
    return {
        commandId: 1,
        jobId: "job",
        botKind: TRADING_BOT_KIND.Bidding,
        commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
        status: TRADING_JOB_COMMAND_STATUS.Pending,
        requestedRevision: 1,
        payload: {},
        attempts: 0,
        lastError: null,
        createdAt: "2026-05-15T00:00:00Z",
        claimedAt: null,
        completedAt: null,
        ...overrides,
    };
}
