import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATS_JOB_STREAM_MAX_AGE_NANOS } from "@artgod/shared/queue/nats-job-stream";
import { BACKFILL_SOURCE } from "@artgod/shared/types/sync-backfill";
import { NatsSyncBackfillCommandQueue } from "./nats-sync-backfill-command-queue.js";

const nats = vi.hoisted(() => ({
    connect: vi.fn(),
    publish: vi.fn(),
    jetstreamManager: vi.fn(),
    streamInfo: vi.fn(),
    drain: vi.fn(),
}));

vi.mock("nats", async (importOriginal) => ({
    ...(await importOriginal<typeof import("nats")>()),
    connect: nats.connect,
}));

const NOW = 1_800_000_000_000;
const commands = [
    { chainId: 1, collectionId: null, fromBlock: 10, toBlock: 19 },
    { chainId: 10, collectionId: 7, fromBlock: 20, toBlock: 25 },
];

describe("NatsSyncBackfillCommandQueue", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        nats.streamInfo.mockResolvedValue({
            config: { max_age: NATS_JOB_STREAM_MAX_AGE_NANOS },
        });
        nats.jetstreamManager.mockResolvedValue({
            streams: { info: nats.streamInfo },
        });
        nats.connect.mockResolvedValue({
            jetstream: () => ({ publish: nats.publish }),
            jetstreamManager: nats.jetstreamManager,
            drain: nats.drain,
        });
    });
    afterEach(() => vi.restoreAllMocks());

    function publisher() {
        return new NatsSyncBackfillCommandQueue(
            "nats://127.0.0.1:42720",
            "backfill-fixture",
        );
    }

    it("publishes source-classified JSON ranges with their chain and optional collection scope", async () => {
        await publisher().publishBackfillRanges(commands);
        expect(nats.connect).toHaveBeenCalledWith({
            servers: "nats://127.0.0.1:42720",
        });
        expect(nats.publish).toHaveBeenCalledTimes(2);
        for (const [index, command] of commands.entries()) {
            const [subject, encoded, options] = nats.publish.mock.calls[index]!;
            const jobId = `sync:manual:${command.chainId}:${command.collectionId ?? "all"}:${command.fromBlock}-${command.toBlock}:${NOW}`;
            // Deliberately assert the serialized queue boundary, including the
            // absence of a second order-policy selector in the payload.
            expect(subject).toBe("backfill-fixture.jobs.events-sync-backfill");
            expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({
                jobId,
                kind: "sync.backfill.range",
                queue: "events-sync-backfill",
                payload: {
                    fromBlock: command.fromBlock,
                    toBlock: command.toBlock,
                    source: BACKFILL_SOURCE.ManualHistorical,
                },
                attempt: 0,
                scheduledAt: NOW,
                chainId: command.chainId,
                ...(command.collectionId === null
                    ? {}
                    : { collectionId: command.collectionId }),
            });
            expect(options).toEqual({ msgID: jobId });
        }
        expect(nats.drain).toHaveBeenCalledOnce();
    });

    it("does not connect for an empty command batch", async () => {
        await publisher().publishBackfillRanges([]);
        expect(nats.connect).not.toHaveBeenCalled();
    });

    it.each(["manager", "stream", "publish"] as const)(
        "drains after a %s failure and preserves the original error if drain also fails",
        async (stage) => {
            const failure = new Error(`${stage} unavailable`);
            if (stage === "manager")
                nats.jetstreamManager.mockRejectedValueOnce(failure);
            if (stage === "stream")
                nats.streamInfo.mockRejectedValueOnce(failure);
            if (stage === "publish")
                nats.publish.mockRejectedValueOnce(failure);
            nats.drain.mockRejectedValueOnce(new Error("drain unavailable"));
            await expect(
                publisher().publishBackfillRanges(commands),
            ).rejects.toBe(failure);
            expect(nats.drain).toHaveBeenCalledOnce();
            expect(nats.publish).toHaveBeenCalledTimes(
                stage === "publish" ? 1 : 0,
            );
        },
    );
});
